# ECS Docker seccomp profile

This is a fail-closed exception to Docker's built-in seccomp policy for the Bubblewrap setup phase.
It is the exact materialized arm64 profile from the production ECS host, plus ten rules. It is not
an unconfined profile and it does not grant a capability.

The base was captured on 2026-08-28 from an ordinary non-privileged container on:

- Amazon Linux 2023, kernel `6.1.180-225.360.amzn2023.aarch64`;
- `docker-25.0.16-1.amzn2023.0.4.aarch64`, Moby build `6fdf0a6`;
- `runc-1.3.5-1.amzn2023.0.2.aarch64` and libseccomp 2.5.3.

Its canonical compact-JSON SHA-256 before the additions was
`25497e540002b93d4503da25ab60b7f292def23af8ae6f53da115ef6092e5f67`. AWS SSM command
`1e25d295-22e2-4cdf-9a73-cc3fedcbbb5d` records that extraction. `ecs-host-bootstrap.sh` refuses to
join a host using a different Docker or runc package; a package/AMI update therefore requires a new
capture, diff, review, and production isolation proof.

The added rules are the exact setup calls observed from Bubblewrap 0.8.0 with the production
arguments:

- `clone(0x7e020011)` creates the initial mount, cgroup, UTS, IPC, user, PID, and network namespaces;
- `mount` accepts only flag words `0x6`, `0xd000`, `0x4c000`, `0x8c000`, `0x209026`, `0x209027`,
  and `0xc0edd000`;
- `pivot_root` is allowed for Bubblewrap's two root transitions;
- `umount2` is allowed only with `MNT_DETACH` (`2`).

`unshare` and `setns` remain denied. After setup, Bubblewrap consumes a sealed classic-BPF program
from one explicitly inherited descriptor and installs it in both its PID-namespace init and the
plugin. That second filter denies `clone`, `clone3`, `unshare`, and `setns`; the plugin cannot reuse
the setup exception. Bubblewrap closes the filter descriptor before `exec`, while core marks every
other non-stdio descriptor close-on-exec.

The profile is daemon-wide because ECS does not expose Docker's per-container seccomp selector.
The host is dedicated to the SproutOS ECS task, privileged containers are disabled in the ECS
agent, and the profile preserves every other deny in Docker's materialized default. Do not replace
this with `unconfined`, `SYS_ADMIN`, a privileged task, or Docker socket access.

Applying the launch-template change does not mutate the running instance. Roll a fresh instance
through the capacity provider, run the signed success/output-limit/timeout proofs there, and only
then drain the old instance. Rollback is the inverse: select the prior launch-template version,
launch and prove a replacement, then drain the candidate. Never edit a live daemon profile in
place.
