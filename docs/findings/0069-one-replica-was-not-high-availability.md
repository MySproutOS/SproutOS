# 0069: One healthy replica was still an outage waiting to happen

The zero-downtime rolling policy fixed releases, but the service returned to one task and one host
after every deployment. A stuck idle host then showed the remaining failure mode: the scheduler had
nowhere to place a replacement, and one serving-host failure would remove both website and API
targets at once.

The steady state is now two tasks on two instances, spread across the two serving availability
zones. `distinctInstance` is the hard placement constraint; availability-zone spread is the first
placement strategy and availability-zone rebalancing is enabled so ECS can keep the replicas
balanced. The ASG floor is two and its ceiling is three. With fixed host ports, that third host is
the only place a replacement can start.

The deployment maximum is therefore 150%, not 200%: at desired count two, ECS may run exactly three
tasks and replaces the replicas sequentially. Minimum healthy remains 100%, so neither old replica
is drained until the replacement passes both website and API target-group health checks. The
workflow and release script both require desired count two, and OpenTofu no longer ignores desired
count drift.

Container Insights remains disabled because its per-service `RunningTaskCount` is a paid custom
metric. Native alarms cover the observable boundary instead: each target group alarms below two
healthy targets and above zero unhealthy targets, while the Auto Scaling group alarms below two
in-service hosts. The ASG explicitly enables that one otherwise opt-in group metric. A task that is
running but cannot answer traffic is correctly treated as absent.
