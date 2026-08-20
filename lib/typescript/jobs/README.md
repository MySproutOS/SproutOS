# @lib/jobs

One background job runner: Postgres, `SKIP LOCKED`, leases, and a dead letter.

## Why there is exactly one

Nine independent schedulers were proposed during design — for fork upkeep, retention sweeps, hold
expiry, usage rating, upstream sync — and every one of them was a job type wearing a scheduler
costume. They all enqueue a row into `background_job` and are claimed by the same loop.

A second scheduling mechanism is a second place for work to get stuck, and a second thing to check
at three in the morning when something did not run.

There is no cron table either. **A recurring job is a row whose idempotency key names the window it
belongs to** (`billing.expire_holds:2026-08-20T10`). Every worker calls `scheduleRecurring` on a
timer; all but one collide on the unique constraint and insert nothing. No leader election, no
coordination.

## `claim` is a CTE, and that is not a style choice

```sql
WITH ready AS (
  SELECT id FROM background_job
   WHERE state = 'queued' AND run_at <= now()
   ORDER BY priority DESC, run_at ASC
   LIMIT $n FOR UPDATE SKIP LOCKED
)
UPDATE background_job SET … FROM ready WHERE background_job.id = ready.id RETURNING …
```

The obvious alternative — `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` — reads
identically and **does not reliably bound the UPDATE**. Written that way, `claim(limit: 1)` was
observed returning _three_ jobs against the real table. The worker ran one and left the other two
in `running` until their leases expired, so the queue advanced one job per lease interval and
looked like a hang.

Run again by hand, the same statement returned one row. It is plan-dependent, which is worse than
being consistently wrong: it behaves in a small test and misbehaves under load. A CTE is an
optimization fence, so the limit and the row locks are evaluated exactly once — correct by
construction rather than by luck. This is why the canonical SKIP LOCKED queue is always a CTE.

`queue.test.ts` pins the contract but does **not** reliably reproduce the failure, and says so.

## Leases, not locks

The claiming transaction commits immediately. A worker that dies mid-job therefore does not hold a
database connection open until someone notices — it holds a `lease_expires_at` that passes.

`reclaimExpired` returns those jobs to the queue **without resetting `attempt`**. A job that
reliably kills its worker should dead-letter, not take out every worker in the pool one at a time,
forever.

`attempt` is incremented at **claim**, not at failure, for the same reason: a worker killed mid-job
never reaches `fail()`, and an attempt counted there would make such a job immortal.

`heartbeat` is scoped to the holder, so a worker whose lease was already reclaimed and handed on
cannot extend it back out from under its new owner.

## `run_at` defaults to the database clock

`enqueue` writes `now()` rather than `new Date()`. `claim` compares `run_at <= now()` **in
Postgres**, so a default taken from the application clock makes a freshly enqueued job briefly
unclaimable whenever the two disagree — which they do, by the round trip if nothing else. This
showed up as tests that passed three times and failed the fourth. An explicit `runAt` is a real
schedule and is left exactly as the caller gave it.

## What ships with it

| kind                   | what it does                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `billing.expire_holds` | Frees reservations whose runner never came back. `availableBalance` subtracts active holds, so an abandoned one makes a customer's money unspendable. Charges nothing.                                                                                             |
| `agent.purge_events`   | Deletes agent transcripts past `expires_at`. `agent_event.payload` holds file contents from a customer's repository, and the 30-day default was a promise nothing kept. Bounded batches, so a neglected table cannot produce one statement that locks for minutes. |

Both were promised by earlier work and had nothing running them.

## Running it

```bash
pnpm --filter=@api/internal run worker
```

A separate process from the API on purpose: a long job holding an event-loop turn inside the API
delays every request behind it, and a worker that needs restarting should not take the API down
with it. Both read the same table and nothing else coordinates them.

`runOne` is exported so a single job can be driven directly — which is what makes a new job type
testable without a poller running.
