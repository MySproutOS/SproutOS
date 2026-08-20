# 0012. Two Kata runtime classes: `kata-fc` and `kata-clh`

- Status: Accepted
- Date: 2026-08-20

## Context

Three areas made three assumptions about the hypervisor, and one of them is refuted by another
area's own finding.

The compute notes, Decision 3: "**dev sandboxes run `kata-clh`** (Cloud Hypervisor) because
Kata+Firecracker has **no virtio-fs** — its only rootfs path is a devmapper thin snapshot hot-plugged
as a virtio-block device, so nothing on the host can write into a running guest's filesystem…
this is exactly why dev is not on `kata-fc`."

The agent notes, Decision 7: "Agents run only inside a tenant microVM (**Kata + Firecracker**
`runtimeClassName`), one pod per session, repo pre-checked-out on an **ephemeral volume**."

The infra notes, Decision 4: `kata-deploy` installs "`runtimeClassName: **kata-fc**`" — one runtime
class registered, full stop.

Under compute's own finding, the agent design cannot work: with Firecracker there is no volume to
pre-check-out into, and the infra design never installs the runtime class the sandbox work needs.

## Decision

Both. `kata-deploy` registers `kata-fc` **and** `kata-clh` from the same DaemonSet, which costs one
label rather than a second node pool.

- **`kata-fc` (Firecracker)** — production site revisions and workflow execution. Immutable image per
  deployment; code enters the guest only by being baked into the OCI image. Smallest attack surface,
  fastest boot.
- **`kata-clh` (Cloud Hypervisor)** — dev sandboxes and agent sessions. These need a live filesystem:
  a checked-out repo, an editor writing files, a terminal. virtio-fs from a PVC is the mechanism, and
  Cloud Hypervisor is the Kata hypervisor that supports it.

## Consequences

- Two `RuntimeClass` objects, one node pool, one `kata-deploy` DaemonSet. Workload type picks the
  class via `runtimeClassName`; nothing else changes.
- Every production deploy is a new image and therefore a new devmapper thin snapshot. There is no
  bind-mount escape hatch, and anything assuming `emptyDir` semantics or a ConfigMap-as-file at
  runtime needs re-checking. ConfigMaps and Secrets are copied into the guest, and large ones are
  slow.
- Node userdata must configure the devmapper snapshotter before containerd starts: a sparse data file
  plus metadata, on local NVMe where the instance has it, sized at roughly 10 GiB per concurrent
  sandbox.
- **Thin-pool exhaustion wedges the whole node**, not one pod. Alert at 70% pool utilization, cordon
  at 85%.
- The agent-area design is amended: agent sessions are `kata-clh`, with the repo on a PVC.
- Two hypervisors means two sets of CVEs to track and two boot-time profiles to measure. Accept it;
  the alternative is either no dev sandboxes or no Firecracker.

## Alternatives considered

**`kata-fc` only** (the infra design). Rejected: dev sandboxes and agent sessions become impossible
without baking every file edit into a new image, which is not an editor.

**`kata-clh` only.** One runtime class, simpler operations, virtio-fs everywhere. Rejected: Firecracker
is the tighter boundary for the untrusted production workloads that run unattended at the highest
density, and it is the isolation story the product sells.
