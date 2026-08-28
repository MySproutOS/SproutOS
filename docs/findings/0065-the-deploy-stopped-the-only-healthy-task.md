# The deploy stopped the only healthy task

The first production rollout after grouped-project metadata returned ALB 503 responses for roughly
ninety seconds. The new image eventually became healthy and the deployment succeeded, so a green
workflow concealed the customer-visible outage inside it.

The ECS service requested one task but set `deployment_maximum_percent = 100` and
`deployment_minimum_healthy_percent = 0`. Those values require ECS to stop the sole old task before
it can place the replacement. Both containers use fixed host ports, so the replacement also could
not share the existing instance. The load balancer therefore had no healthy website or API target
while the replacement started.

The ASG already allowed one additional instance and the ECS capacity provider already managed its
desired capacity. The service now uses maximum 200 and minimum healthy 100. ECS keeps the old task,
scales the ASG from one instance to two, waits for the replacement to pass both target-group health
checks, drains the old task, and then scales the empty instance back in. ECS managed scale-in waits
for its empty-capacity alarm data; [AWS documents fifteen one-minute data points][managed-scaling]
before scale-in starts, so the second instance can remain for roughly another fifteen minutes after
it becomes empty.

The overlap is intentionally billable infrastructure: for each deployment, one extra instance runs
for placement, startup, health checks, draining, and the managed scale-in delay. Saving those
bounded instance-minutes by deliberately removing all healthy capacity made every ordinary release
an outage.

The release script repeats the deployment configuration on `update-service` because deployments do
not apply OpenTofu. Its ECS waiter and rollback waiter are bounded. A timeout or failed target-health
assertion explicitly restores the exact task revision observed before the release; a circuit-breaker
rollback is detected rather than misreported as a successful new release.

[managed-scaling]: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/managed-scaling-behavior.html
