# The group had no database

**Found by:** completing the first real production Agent turn on Daytona, then comparing the
sandbox row, the agent's environment, and the services shown beneath its project group.

## What looked true

The sandbox provisioning code said it looked up Postgres for both a project and its group. The
injected skill told the agent that `DATABASE_URL` named its isolated Neon branch, and the existing
Neon test had created and deleted such a branch against the real provider.

## What was actually true

The production sandbox belonged to the `reddit-clone` group. Its Postgres service belonged to the
deployable `redditclone-web` child, which is the topology the group UI creates. The lookup supported
a child finding a service attached to its parent, but not a group finding a service attached to a
child. It returned no service, provisioning treated no database as normal, and Daytona started
successfully with no `DATABASE_URL` and `sandbox.database_branch_id = null`. The agent's database
tests then tried localhost and failed.

This passed the real-Neon test because that test began after service selection: it proved that a
known service could be branched, not that a group sandbox could find the service it needed.

## What stops it recurring

Service selection now resolves, in order, a service on the selected project, its parent group, or
its direct children. Creation time is the deterministic tie-breaker within a scope. A
database-backed test constructs the production shape -- group, deployable child, Postgres on the
child -- and asks from the group, so removing the child direction returns `undefined` instead of the
service id.

## Historical context

This closes the gap between the Neon-branch promise in `private_notes/groups.md` and the provider
handoff in `private_notes/sandbox-handoff.md`. It is part of the launch chain recorded in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
