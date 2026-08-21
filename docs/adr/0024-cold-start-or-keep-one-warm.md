# 0024 — Two scale modes: cold start, or keep one warm

## Status

Accepted.

## Context

A tenant deployment has to answer a request quickly, and idle capacity has to cost nearly nothing.
Those pull against each other, and the honest answer is to let the customer choose rather than to
pick one and call it a platform property.

The obvious model to copy is Vercel's Fluid compute, so it is worth being precise about what it
actually does — the marketing and the mechanism are different documents.

### What Vercel actually does

Three things, and only two of them are reproducible here.

**In-function concurrency.** One instance serves many requests at once, rather than one instance per
request. This is the part Fluid is named for and the part SproutOS already has:
`deployment.container_concurrency` is exactly this dial, and Knative's `containerConcurrency` is the
same mechanism. A web request spends most of its life waiting on a database, so one container can
hold dozens of them without contention.

**Scale to one, not to zero.** Vercel keeps at least one instance for a deployment rather than
tearing the last one down, and says plainly: _"We always keep at least one function instance
running. Instead of scaling to zero, we scale to one."_ They also say it costs the customer nothing
extra — _"you only pay when your app receives usage, unlike dedicated servers that run 24/7."_

Those two statements are only compatible because of the third thing.

**A retained instance is paused, not running.** Their pricing documentation is where the mechanism
leaks: _"After all requests complete, the instance is paused, and no CPU or memory charges apply
until the next invocation."_ Active CPU is billed at $0.128/hour and provisioned memory at
$0.0106/GB-hour, and both stop between requests. So "scale to one" means _keep the instance in a
resumable state_, not _keep a server running_. The retention is what removes the cold start; the
pause is what makes it free.

That is a Firecracker-shaped capability — freeze a microVM's memory and restore it in milliseconds —
and it needs bare metal and a snapshotting runtime. **SproutOS runs on managed Kubernetes with
Knative, where a retained pod is a running pod.** We cannot pause one and stop paying for it.

Claiming otherwise would be the kind of thing `docs/findings/` is full of.

## Decision

Two modes, named for what they cost rather than for what they resemble.

**`cold` — scale to zero.** `minScale: 0`. Nothing runs while nothing is asked for, and the platform
reserves nothing. The first request after an idle period waits for a container to start: Knative's
activator holds the request rather than dropping it, so the cost is latency and not an error. A
`scale-down-delay` keeps the instance for a few minutes after the last request, which removes the
cold start for bursty traffic without holding capacity overnight.

**`warm` — keep one.** `minScale: 1`. One instance always exists, so no request ever waits for a
container to start. This is genuinely a running pod and the platform reserves its memory
continuously.

The default is `cold`, because the platform's premise is that idle costs nothing.

### Why `warm` is still cheap for the customer

The two costs are not the same cost, and conflating them is what makes always-on sound worse than it
is here.

**SproutOS bills on measured usage, not on reserved size.** `services/metering-agent` samples
`cpu.stat` and `memory.current` per pod. An idle container burns almost no CPU, so a warm instance's
_metered_ cost is close to its memory footprint and nothing else — which is the same shape as
Vercel's "you only pay when your app receives usage", arrived at from the other direction: they stop
the clock, we measure the work.

What `warm` genuinely costs the _platform_ is a reserved slot on a node. That is a real cost and it
is the reason this is a choice rather than a default.

## Consequences

- `project.scale_mode` is the customer's setting; `deployment.scale_mode` records what a given
  revision actually ran with, for the same reason `deployment.runtime_class` does — a deployment is
  a historical fact and must not be re-described by a later settings change.
- The renderer sets `autoscaling.knative.dev/min-scale` from it. Nothing else in the spec changes,
  so switching modes is a new revision and not a different code path.
- **We do not get Vercel's third property**, and the difference is worth stating rather than
  implying: a `warm` instance here is running, and it is billed for the memory it holds. If SproutOS
  ever runs on bare metal with Kata (ADR 0012), snapshot-and-resume becomes available and `warm`
  can become what Vercel's is — retained and free. That would be a change to this ADR, not a change
  to the customer's setting.

## Sources

- [Scale to one: How Fluid solves cold starts](https://vercel.com/blog/scale-to-one-how-fluid-solves-cold-starts)
- [How Fluid compute works on Vercel](https://vercel.com/blog/how-fluid-compute-works-on-vercel)
- [Introducing Active CPU pricing for Fluid compute](https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute)
- [Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)
