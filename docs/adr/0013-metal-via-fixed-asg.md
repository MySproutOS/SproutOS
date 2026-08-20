# 0013. Metal nodes come from a fixed-size ASG, not Karpenter

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas designed the tenant node pool two different ways.

The compute notes, Decision 1: "**Two Karpenter NodePools**: `control` (c7i/m7i, spot-tolerant, all
SproutOS services) and `tenant-metal` (`*.metal`, on-demand only, taint
`sproutos.io/tenant=true:NoSchedule`, label `katacontainers.io/kata-runtime=true`)."

The infra notes, Decision 8: "**Karpenter v1 manages only the `system`/burst pools; the `.metal` pool
is a fixed-size ASG** — metal instances take 10–20 min to boot, which makes them unusable as a
just-in-time scaling unit."

The infra position is the operationally sound one. Karpenter's value is provisioning a node in
response to a pending pod, in the tens of seconds. A bare-metal instance takes ten to twenty minutes
to reach `Ready`, and it must additionally build the devmapper thin pool in userdata before
containerd starts. A user's first request must never wait on that.

Karpenter's consolidation behaviour is the second problem. Its default
`WhenEmptyOrUnderutilized` policy will bin-pack by evicting pods — including tenant microVMs holding
live dev sandbox state.

## Decision

The `tenant-metal` pool is a fixed-size Auto Scaling Group, sized deliberately and changed by a
`tofu apply`. Karpenter manages the ordinary `system` and burst pools only.

## Consequences

- Metal capacity is a planned quantity, reviewed against measured density. The infra notes' thesis —
  roughly a thousand scale-to-zero tenants parked on one node at 0.25 vCPU / 512 MiB with
  overcommit — is what makes this tractable: capacity changes on a weekly cadence, not a per-pod one.
- Scaling up is a human decision with a ten-to-twenty-minute lead time. Keep headroom: a
  low-priority pause-pod ballast that real workloads preempt, so there is always a warm node's worth
  of slack.
- **`InsufficientInstanceCapacity` on `*.metal` is real.** Configure at least three arm64 metal
  families in the ASG and hold an On-Demand Capacity Reservation for the baseline node.
- No consolidation evicts a sandbox. If we later add any disruption automation to this pool, sandbox
  pods carry `do-not-disrupt`.
- The ASG is a fixed cost floor. One node is the largest single line item in the monthly bill, which
  is why phase 10 proves the entire build → image → revision → URL loop on ordinary nodes at
  roughly $0.10/hr before metal is a sunk cost.
- Set a hard `limits.cpu` on the Karpenter-managed pools regardless. One runaway reconcile loop can
  provision thousands of dollars a day.

## Alternatives considered

**Karpenter for metal too** (the compute design). Rejected on boot time and consolidation, as above.

**Spot metal.** Roughly half the cost. Rejected for the baseline: a Spot interruption evicts every
tenant microVM on the node, and bare-metal Spot pools are thin enough that reacquisition is not
assured. Revisit for a burst tier that carries only stateless production revisions.
