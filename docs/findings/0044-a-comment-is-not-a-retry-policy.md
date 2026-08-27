# A comment is not a retry policy

## What was wrong

The migration runner said “not retried, here or anywhere,” but three independent retry paths could
run a partially applied migration again:

- the AWS SDK's default retry policy wrapped the synchronous Lambda `Invoke`;
- `deploy.release` could be restarted by the generic background queue without remembering that its
  migration had already started; and
- a migration could run for Lambda's 15-minute ceiling while its queue lease expired after five
  minutes, allowing another worker to reclaim the same job.

The migration status was also read before waiting for the per-project advisory lock. Even if the
first worker finished while a reclaimed worker waited, the second worker retained the stale
`pending` value and could invoke the migrator again after acquiring the lock.

## Why the checks missed it

The tests covered runtime validation and the migrator's returned success/failure value. None sent a
retriable HTTP failure through the real AWS SDK retry middleware, and none crossed the queue lease
boundary. The no-retry guarantee existed only in comments around the happy-path invocation.

## What stops it coming back

Only the synchronous `Invoke` uses a cloned Lambda client with `maxAttempts: 1`; function creation
and configuration retain normal SDK retries. A real HTTP test returns a retriable 500 and asserts
that exactly one request reaches the server.

Migration releases heartbeat their lease during the blocking invoke. The handler re-reads
migration state inside the project lock: `succeeded` resumes publication without rerunning the
migration, `failed` stops, and `running` is treated as an ambiguous prior attempt that requires a
human to inspect the database. Invocation/transport errors are recorded and returned rather than
thrown into the generic retry wrapper. The release job may still retry later publication work,
which is safe and remains useful; a unit test pins the migration resume state machine.

## Launch-plan context

This closes Phase 7's “do not retry a migration automatically” requirement in
`read-the-readme-md-to-eventual-dusk.md`. It also corrects the launch reporting in
`private_notes/groups.md`: having a standalone action and a migration Lambda was not evidence that
the whole execution path was single-attempt.
