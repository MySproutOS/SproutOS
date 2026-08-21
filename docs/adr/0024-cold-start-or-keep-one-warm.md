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

**A retained instance is paused between requests.** Their pricing documentation is explicit:
_"After all requests complete, the instance is paused, and no CPU or memory charges apply until the
next invocation."_ Active CPU is billed at $0.128/hour and provisioned memory at $0.0106/GB-hour,
and both stop between requests. So "scale to one" means _keep the instance in a resumable state_,
not _keep a server running_: the retention removes the cold start and the pause is what makes it
free.

### A correction, and the limit of what is known

An earlier draft of this ADR said that pause "is a Firecracker snapshot and it needs bare metal."
**That was an inference from one sentence and the documentation contradicts it.** Vercel's own page
on isolation says the opposite of what a per-invocation microVM would imply:

> Because each function uses a microVM for isolation, which can lead to slower start-up times, you
> can see an increase in resource usage due to idle periods when the microVM remains inactive.
> Fluid compute uses a different approach to isolation. Instead of using a microVM for each function
> invocation, multiple invocations can share the same physical instance (a global state/process)
> concurrently.

Fluid moves _away_ from a microVM per invocation, toward many invocations sharing one process. What
is paused is a process, not a snapshotted VM.

**What the pause actually is — freeze, suspend, or simply not billed — is not documented anywhere
public.** It is stated as a billing property every time it appears, and the mechanism is never
named. This ADR asserts only what the sources say, and the design below does not depend on knowing.

**There is also no cold/warm switch on Vercel.** The settings a user controls are `fluid`,
`maxDuration`, `region` and `memory`; scale-to-one is automatic on Pro and Enterprise. The two modes
below are SproutOS's design, not a reproduction of theirs, and are offered because on Knative the
two genuinely cost different amounts and only the customer knows which trade they want.

## Decision

Two modes, named for what they cost rather than for what they resemble.

**`cold` — scale to zero.** `minScale: 0`. Nothing runs while nothing is asked for, and the platform
reserves nothing. The first request after an idle period waits for a container to start: Knative's
activator holds the request rather than dropping it, so the cost is latency and not an error. A
`scale-down-delay` keeps the instance for a few minutes after the last request, which removes the
cold start for bursty traffic without holding capacity overnight.

**`warm` — keep one.** `minScale: 1`. One instance always exists, so no request ever waits for a
container to start. This is genuinely a running pod and the platform reserves its memory
continuously — Knative has no notion of a retained-but-paused revision, and whatever Vercel does
between requests, we cannot do it here.

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
- **A `warm` instance here is running and reserves memory.** Vercel's is not billed between
  requests; ours is. Whether that gap is closable depends on a mechanism nobody has published, so
  this ADR does not promise a path to it. If a future runtime here can suspend a revision and stop
  charging for it, `warm` changes meaning and this ADR changes with it — the customer's setting
  would not.

## Sources

- [Scale to one: How Fluid solves cold starts](https://vercel.com/blog/scale-to-one-how-fluid-solves-cold-starts)
- [How Fluid compute works on Vercel](https://vercel.com/blog/how-fluid-compute-works-on-vercel)
- [Introducing Active CPU pricing for Fluid compute](https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute)
- [Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Fluid compute — isolation boundaries and global state](https://vercel.com/docs/fluid-compute)
