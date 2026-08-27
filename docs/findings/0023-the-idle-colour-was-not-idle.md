# 0023 — The idle colour was not idle

The blue/green deployment moved traffic to the new website and router instances but left the old
Auto Scaling groups at desired capacity one. Both releases therefore remained alive after every
successful deployment.

For the website that was a needless instance bill. For the router it was a correctness bug: the
same release also runs background workers, so a process from the drained colour could claim a
sandbox job after traffic had moved. A browser could submit work through the current release while
an older release provisioned, stopped, or destroyed the Daytona workspace.

This was observed in production after two consecutive successful deployments. The load balancer
served the newer green release while the blue instance still ran the preceding release, and both
Auto Scaling groups reported desired capacity one.

## Why the previous checks passed

`fill-idle.sh` intentionally raises the idle colour to one before a deployment. `cutover.sh`
verified target health, moved every listener, and read the listener back. Nothing owned the inverse
operation after the move. OpenTofu ignores desired-capacity drift because the deployment scripts
own it, so a later apply correctly preserved the accidental second instance.

The cutover tests stopped at the routing boundary. They proved which colour received traffic, not
which processes were still able to consume background work.

This repeats the evidence boundary recorded by
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: listener health is not proof
that the displaced release stopped. It also matters to the isolation program in
`/Users/andrew/.claude/plans/double-sorted-meteor.md`, because a durable sandbox job must not be
executed by an arbitrary previous version of the control plane.

## What stops it coming back

After the primary listener is freshly read back on the target colour, `cutover.sh` sets the drained
website or router Auto Scaling group to desired capacity zero. It retries transient AWS failures,
reads desired capacity back, and refuses to report the deployment complete unless the old group is
zero. A dry run, failed traffic move, and no-op cutover do not change capacity.

The tests model both Auto Scaling groups and assert that the serving colour remains at one while
the drained colour reaches zero. They also cover transient failures and the permanent-failure case
where traffic moved but old capacity could not be drained.
