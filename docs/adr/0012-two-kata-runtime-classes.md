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

---

## Amendment, 2026-08-21: gVisor where there is no metal

This ADR chose two Kata runtime classes and said nothing about clusters that cannot have either.
Kata needs a bare-metal node pool — nested virtualization, `kata-deploy`, a devmapper thin pool —
and a managed Kubernetes offering does not give you one. GKE, AKS and EKS all decline in the same
way: `kata-fc` and `kata-clh` are RuntimeClass objects you can create, and no node will ever
implement the handler.

The consequence was not "no VM boundary". It was worse, and it took a while to see: the code named
`kata-clh`, no node provided it, and `sandboxRuntimeClass()` returned `undefined` — so customer code
ran in an ordinary container while `sandbox.runtime_class` said `kata-clh`, because that was the
column default. The isolation was a namespace, a NetworkPolicy and a pod with no service-account
token. All real, none of it a kernel boundary, and the database claimed otherwise.

**GKE Sandbox (gVisor) is the boundary that is actually available on managed Kubernetes.** It is a
user-space kernel: the workload's syscalls are served by `runsc` rather than by the host kernel, so a
kernel exploit reaches gVisor's reimplementation instead of the node's. That is weaker than a VM —
gVisor's own documentation says so — and enormously stronger than a shared kernel with seccomp.

It is also verifiable from inside, which matters more than the argument:

```
sandbox: Linux 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016
node:    6.12.85+
```

gVisor reports that exact fixed uname. A sandbox seeing a decade-old kernel on a node running 6.12
is not configuration one can misread.

### What this changes

- `SANDBOX_RUNTIME_CLASS` is set to `gvisor` on a cluster with a GKE Sandbox node pool, `kata-fc` or
  `kata-clh` on metal, and left unset where there is neither. All three are supported and the row
  records which one a pod actually got.
- The sandbox pod specs carry a toleration for `sandbox.gke.io/runtime=gvisor:NoSchedule`, the taint
  GKE puts on a sandbox node. Without it a pod naming `runtimeClassName: gvisor` is Pending forever
  and the reason appears only in its events.
- `sandbox.runtime_class` no longer enumerates. It checked `kata-fc`/`kata-clh`, then gained `none`,
  then rejected `gvisor` — three times the *truth* was refused while a stale default stayed legal. A
  RuntimeClass is created on the cluster; the schema cannot know the set, so it checks the shape.

### What this does not change

Kata remains the choice on metal, and the two-class distinction stands for the reason it always did:
Firecracker has no virtio-fs, so anything needing a live filesystem is Cloud Hypervisor. gVisor is
what a cluster gets when it has no metal, not a replacement for having any.
