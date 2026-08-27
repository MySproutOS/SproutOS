# The transcript was the workspace

**Found by:** completing a production Daytona turn, opening its signed Preview, then returning to
the Agent route in Chrome.

## What looked true

The Agent route queried durable sessions and the sandbox itself remained `running`. The header had
controls for starting a new chat and deleting the paid workspace.

## What was actually true

The queried sessions were never read. Conversation identity lived only in component state, while
both controls were enabled by `bubbles.length`. Navigating to Preview unmounted the route, erased
the bubbles and session id, and remounted an empty-looking Agent page. The real Daytona workspace
continued running and billing, but its Done button was disabled because no transcript pixels were
on screen.

## What stops it recurring

The route adopts the newest resumable session from the sessions API once per mount. New Chat keeps
an explicit adoption guard, so clearing the current session is not immediately undone by the
query. Done is now enabled by the sandbox API, not the local transcript; finishing removes that
query from the cache only after the provider object and control-plane row are both gone.

Focused tests assert that only active or idle sessions are restored, while completed sessions are
not revived. The production browser path -- Agent to Preview to Agent -- is the final regression
check because route unmounting is the event that exposed it.

## Historical context

This extends the Daytona lifecycle and preview work recorded in `private_notes/groups.md` and
`private_notes/sandbox-handoff.md`. It is part of the launch chain recorded in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
