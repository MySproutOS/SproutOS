# 0011. Tenant compute is arm64 (Graviton metal)

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas chose two instruction sets for the same node pool, and the cost model rests on one of them.

The compute notes, Decision 2: "Start on **`c7i.metal-24xl`** (96 vCPU / 192 GiB, ~$4.284/hr →
~$0.045/vCPU-hr)" — x86, chosen against Vercel's $0.128/active-CPU-hr for a margin comparison.

The infra notes, Decision 4: node group "`tenant-metal` (self-managed **`c6g.metal`**, cheapest bare
metal at **$2.176/hr**)" — arm64, and the entire baseline cost table depends on that hourly rate.
That area's open question 3 then asks the question it had already answered: "arm64 (`c6g.metal`)
forces arm64 tenant images — do we build multi-arch in the app-store pipeline, or accept x86
`c5.metal` at $4.08/hr?"

The critique notes that "cheapest bare metal" is overstated — older families undercut `c6g.metal` —
but the comparison that matters is c7i-vs-c6g at roughly half the hourly cost for the same class of
work.

Cost per tenant-hour _is_ the product thesis. The landing page promises $0.04/month. A 2x difference
in the metal line item is not a preference.

## Decision

arm64. Tenant workloads run on Graviton bare metal. One node pool, one build target,
`aarch64-unknown-linux-musl` for the Rust data-plane services and `linux/arm64` images for
everything else.

## Consequences

- **Store apps must build for arm64.** Every forkable listing in the catalogue needs an arm64 image,
  which is the real cost of this decision. Node, Python, Go, and Rust all build cleanly on Graviton;
  anything shipping x86-only prebuilt binaries (some ML wheels, some proprietary agents) cannot be
  listed until it does.
- The build pipeline runs on the same arm64 metal pool, so builds are native rather than emulated.
  QEMU-emulated cross-builds are slow enough to be a product problem, not just a CI annoyance.
- Control-plane nodes are also Graviton (`m7g.large`), so there is one architecture across the
  cluster and one set of images.
- The Rust services in `services/` build static musl binaries into `scratch`/distroless images: a few
  megabytes, instant start, which is what makes a per-node DaemonSet cheap on metered metal.
- Metal capacity for any single family is thin. Configure at least three arm64 metal families in the
  node group and hold an On-Demand Capacity Reservation for the first node.
- Local development on Apple Silicon is the same architecture as production, which removes a whole
  class of "works on my machine" divergence.

## Alternatives considered

**x86 `c7i.metal-24xl`** (the compute design). Broader image compatibility, no store-app porting
burden. Rejected on cost: roughly double the hourly rate for the tenant pool, which is the single
largest recurring line item in the plan.

**Multi-arch node pools.** Rejected: two build targets, two image sets, two capacity pools, and a
scheduler decision on every deploy — all to avoid porting a handful of store listings.
