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

A later production deployment exposed a second route to the same bad state. The cutover correctly
set the drained router group to desired capacity zero, but its target-tracking policy remained
active. NLB `ActiveFlowCount` stayed non-zero during connection draining while healthy targets fell
to zero, so the alarm raised desired capacity from zero to three and then six. The idle colour was
recreated before the deployment's final verifier could observe it empty.

The policy threshold was also disconnected from the resource it was meant to protect. A controlled
production measurement distributed 600 established idle TLS sessions across six `t4g.micro`
routers. Aggregate router RSS increased by 22.5 KiB per connection; cgroup-accounted memory,
including socket and runtime memory, increased by 25.4 KiB per connection. Scaling at 100 flows was
therefore not a memory boundary. It let unauthenticated public TCP activity control instance count.

## Why the previous checks passed

`fill-idle.sh` intentionally raises the idle colour to one before a deployment. `cutover.sh`
verified target health, moved every listener, and read the listener back. Nothing owned the inverse
operation after the move. OpenTofu ignores desired-capacity drift because the deployment scripts
own it, so a later apply correctly preserved the accidental second instance.

The cutover tests stopped at the routing boundary. They proved which colour received traffic, not
which processes were still able to consume background work.

The first capacity fix also treated desired capacity zero as durable. That is only true when no
scaling policy is still authorized to change it. The metric and policy were valid for the live
colour, so infrastructure validation and the live target's health did not expose that the same
alarm process was still enabled on the drained colour.

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

`fill-idle.sh` now suspends the idle group's `AlarmNotification` process before it drains or fills
that group. After a successful listener read-back, `cutover.sh` keeps the drained colour suspended
and resumes `AlarmNotification` only on the newly live colour. A retried no-op cutover reconciles
those process states as well. Suspending this one process leaves boot, health replacement, and
explicit desired-capacity changes available while preventing target-tracking alarms from reviving
an idle fleet.

Normal service capacity is one instance, the per-colour hard ceiling is two, and the tenant-edge
scale-out target is 1,000 concurrent flows per healthy live router. One live and one staged instance
are the ordinary deployment overlap. The live colour may add its second instance under sustained
load; the idle colour cannot act on an alarm. The 2,048-connection application admission limit
remains the final per-router boundary.

The tests model both Auto Scaling groups and assert that the serving colour remains at one while
the drained colour reaches zero. They also cover transient failures and the permanent-failure case
where traffic moved but old capacity could not be drained. The fill and cutover tests additionally
assert that target tracking is suspended before idle capacity changes, resumed only for the live
group, left untouched by a dry run or failed move, and reconciled by an already-live retry.
