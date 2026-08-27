# The APK claim was only conditional in a subquery

## What was wrong

`claimSigningJob` updated the row whose id matched a scalar subquery selecting the oldest eligible
job. The pending-or-stale condition existed only inside that subquery. Two statements could both
select the same pending id, then one would wait for the other's row lock. After the first committed,
Postgres rechecked the waiting update's outer condition — only `id = selected_id` — and the second
signer replaced the first signer's claim. Both requests returned the same APK as their work.

The completion guard limited the eventual damage: only the signer named by the last update could
complete the database row. It did not prevent both machines from downloading and signing the
artifact, and made the first signer's legitimate completion look like a lost lease.

## Why the checks caught it late

The test did issue two claims concurrently against Postgres, but the broken result depends on the
two statements selecting before either update commits. It therefore passed or failed according to
the database scheduler. During launch verification it failed in unrelated pull requests often
enough to become a shared CI blocker instead of being dismissed as a rerun problem.

The original launch plan in `read-the-readme-md-to-eventual-dusk.md`, the later
`double-sorted-meteor.md` plan, and `private_notes/groups.md` did not record this signing-queue race.
The failure was discovered by executing the launch checks, not by completing an item those reports
already knew about.

## What stops it coming back

The claim now uses the same CTE shape as the background-job queue: select one eligible row with
`FOR UPDATE SKIP LOCKED`, then update only the row returned by that locked CTE. A competing signer
cannot select the held row and can claim the next eligible job without waiting. The existing real
Postgres concurrency regression asserts that exactly one of two simultaneous pollers receives the
single queued job; stale-claim and holder-scoped completion tests cover the lease handoff.
