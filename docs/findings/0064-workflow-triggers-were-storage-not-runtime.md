# 0064: Workflow triggers were storage, not runtime

The RedditClone launch audit found that the platform could store `trigger.cron`, accept BullMQ
delayed jobs, and display `workflow_schedule`, but none of those facts caused work at the promised
time. Manual trigger data was also discarded before an action ran, and Lambda Web Adapter treated
an HTTP 500 from an asynchronous queue drain as a successful Lambda invocation.

This is the platform half of the customer report in `TestSproutOS/redditclone#7`. That report in
turn preserves the history the launch work was asked not to lose:

- `private_notes/groups.md`
- `private_notes/sandbox-handoff.md`
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`
- `/Users/andrew/.claude/plans/double-sorted-meteor.md`

Those plans describe the intended workflow and sandbox product. The handoff is the important
correction: earlier verification used a local Docker substitute instead of Daytona, so a stored
shape or a passing stub was never evidence that the production trigger path existed.

## What was missing

1. A BullMQ delayed enqueue woke the router immediately. The worker found nothing due, returned,
   and no later command existed to wake it at the delayed timestamp.
2. `workflow_schedule.next_run_at` was read for display only. No recurring job claimed due rows or
   created workflow runs, and saving a cron graph never materialized a schedule.
3. A trigger payload lived only at the caller. Step execution received immutable node config, but
   not the event that selected the values an action should process.
4. Lambda Web Adapter's default success range includes HTTP 500. An asynchronous queue drain could
   fail while Lambda recorded success and skipped its built-in event retries.

## What now prevents recurrence

- The router drains only due master-wake entries. After any queue enqueue wake, it reads the
  tenant's namespaced BullMQ delayed set and preserves the earliest encoded timestamp as a future
  wake. A short due-time grace avoids a hot loop while an asynchronous Lambda starts.
- Saving a graph transactionally upserts or removes its sole schedule. A minute-keyed platform job
  claims due schedules with `FOR UPDATE SKIP LOCKED`, creates the run, steps, usage outbox event and
  background job atomically, then advances past missed ticks using the configured IANA timezone.
- Trigger input stays separate from versioned action config and is propagated in the
  `sproutos.kind = workflow.node` envelope.
- Every adapted function receives `AWS_LWA_ERROR_STATUS_CODES=500-599`.

The tests assert DST-aware cron calculation, missing cron rejection, payload separation, BullMQ's
4096 score encoding, physical delayed-key construction and the adapter failure range. The customer
repository remains responsible for mapping each legacy BullMQ processor onto its graph/action;
this change supplies the runtime contracts those mappings require.
