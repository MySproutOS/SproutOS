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

## What stops it recurring

`sandbox.start` now treats provider 404 as reconciliation evidence. Under a row lock it clears the
stale external id, returns the row to `starting`, and enqueues one idempotent `sandbox.provision`
job keyed by the missing provider id. Concurrent observations collapse into the same replacement.
A database-backed test starts a row whose provider object is missing and asserts both the cleared
join and the replacement job.

## Historical context

This was invisible to the Docker substitute described in `private_notes/sandbox-handoff.md`: a
local container cannot disappear according to Daytona while its control-plane row survives. It is
part of the launch chain recorded in `private_notes/groups.md`,
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`, and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
