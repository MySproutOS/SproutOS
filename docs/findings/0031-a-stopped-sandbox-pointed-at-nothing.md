# A stopped sandbox pointed at nothing

**Found by:** sending the first real production Agent turn after the Daytona-only lifecycle was
deployed, then comparing the failed start job with Daytona's live sandbox list.

## What looked true

The control-plane row was `stopped` and carried a Daytona external id, so the next request selected
the cheap resume path. The UI waited for `running` and reported `The sandbox failed to start`.

## What was actually true

Daytona had no sandbox with that id. A prior cleanup had correctly treated a missing provider
object as stopped, but it left the external id on the row. `sandbox.start` retried that dead id,
marked the row failed, and the reaper turned it back into stopped. Every later request repeated the
same loop; none could reach provisioning or a model.

The first repair covered `sandbox.start`. The next production retry exposed the other entrance to
the same state: a `failed` row intentionally selects `sandbox.provision` so it can rerun bootstrap,
and that handler also trusted a non-null external id. The replacement job therefore retried the
same missing object before it could create anything.

Once a real replacement existed, its first transient clone failure exposed a third state edge. The
handler wrote `failed`, then the queue retried the same provision job without moving the row back to
`starting`. The forward proxy correctly denies a failed sandbox, so every retry denied its own Git
traffic. The same proxy request returned 200 when the disposable production row was restored to
`starting`, proving the provider, derived credential, and unrestricted public destination policy.

## What stops it recurring

Both `sandbox.start` and the existing-object path in `sandbox.provision` now treat provider 404 as
reconciliation evidence. A shared routine locks the row, drops an attached ephemeral Neon branch
whose one-way credential cannot be recovered, clears the stale external id, returns the row to
`starting`, and enqueues one idempotent `sandbox.provision` job keyed by the missing provider id.
Concurrent observations collapse into the same replacement. Database-backed tests drive both job
entrances and assert the cleared join and replacement job.

Every failed provision retry now conditionally re-enters `starting` before its first provider call,
which restores proxy authorization while preventing two distinct jobs from retrying the same row.
A database-backed test observes the state from inside the provider call, then verifies that a real
failure still returns the row to `failed` for the next bounded retry.

## Historical context

This was invisible to the Docker substitute described in `private_notes/sandbox-handoff.md`: a
local container cannot disappear according to Daytona while its control-plane row survives. It is
part of the launch chain recorded in `private_notes/groups.md`,
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
