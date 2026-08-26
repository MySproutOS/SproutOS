# 27. `pg-proxy` is built, tested, and not deployed

**Status:** superseded on 2026-08-26 by the amendment at the end of this file — the proxy is
deployed, as a listener on the router rather than as a service
**Original status:** accepted, and reversible in one commit
**Date:** 2026-08-24
**Supersedes in part:** [0026](0026-aws-only-lambda-and-two-rust-proxies.md), which named two Rust binaries

## The question

Managed Neon does what `pg-proxy` was written to do. So does the platform still need it?

That question was asked once and never answered, and the answer had already been made by the
architecture without anybody writing it down — which is the worst state for a security boundary to
be in. Somebody reading `services/pg-proxy` today finds a maintained crate with twenty-one passing
tests and no way to tell whether it is load-bearing or dead.

## What the proxy was for

Three things:

1. **Tenant authentication.** A customer connects with a SproutOS credential, not a Neon one, and
   never holds the database's real password.
2. **Wake-on-connect.** Under self-hosted Neon, a suspended compute had to be woken by something
   before a connection could be spliced through.
3. **Connection pooling**, so a serverless application opening a connection per invocation does not
   exhaust the database.

## What is true now

**(2) is gone.** Managed Neon wakes its own endpoints. Measured against the real API rather than
read from marketing: disabling an endpoint took **0.24 seconds**, and the next connection is
refused with `ERROR: The endpoint has been disabled.` until it is enabled again. Nothing has to
wake anything.

**(3) is gone.** Neon ships PgBouncer in front of every endpoint; a customer using the pooled
connection string gets pooling without a hop through us.

**(1) survives, and it is the whole remaining case.** A customer holding a Neon password is a
customer who can reach their database without us — which is fine until they are suspended, at which
point the enforcement point we rely on is gone. `apps/internal-api/src/v1/pg-resolve.ts` exists to
serve exactly this: the proxy asks which endpoint to connect onward to, and a suspended service
resolves to nothing.

## The decision

**Not deployed under v2, and not deleted.**

Nothing in `tofu/` creates an Auto Scaling group, a target group or a listener rule for it. That was
not a decision anybody took — it is what fell out of writing `compute.tf` for the website and the
router — but it is the right outcome, and this ADR is it being taken deliberately rather than by
omission.

Not deleted, because the code is the only implementation of a boundary the platform may want back,
and it costs nothing to keep: it builds in CI and its tests run, so it cannot rot silently. Deleting
a working security boundary to tidy a directory is a trade with no upside.

## What would bring it back

Any of these, and the decision should be revisited:

- Customers are given Neon connection strings directly and suspension stops being enforceable at
  the point of connection.
- A customer needs Postgres on a provider that does not pool or wake, in which case (2) and (3)
  return with it.
- Per-tenant connection caps become necessary — Neon's pooler does not know about our tenancy.

Bringing it back is an ASG, a target group and a listener rule in `compute.tf`, and a `services/`
entry in the deploy workflow. The resolve endpoint, the SCRAM implementation and the tests are
already there.

## What this does not decide

Whether SproutOS uses managed Neon at all. That is settled in
[0025](0025-self-hosted-neon.md) and needs a `NEON_API_KEY`, which is not something this repository
can obtain for itself.

---

## Amendment, 2026-08-26: it came back, and it was cheaper than this ADR assumed

"What would bring it back" listed three triggers. None of them fired. What changed was the price.

This ADR reasoned about deployment as though the only shape available were the one `compute.tf`
already had: an Auto Scaling group, a target group, a listener rule, and a `services/` entry in the
deploy workflow, for a fourth process. Weighed against one surviving argument, that was a fair call.

But [0026](0026-aws-only-lambda-and-two-rust-proxies.md) had already made the other shape available
and this ADR did not notice, even while citing it. `valkey-proxy` and `search-proxy` are libraries
compiled into the router precisely because three deployments doing the same thing — identify a
tenant, rewrite, forward — is three sets of scaling and health checks for one idea. `pg-proxy` was
written the same way, with everything in a library and a thin `main` on top. As
`listeners::postgres` it is a port and an environment variable, gated on its upstream exactly as the
other two are, returning `None` where a deployment has none.

So the decision this ADR took was right about the argument and wrong about the alternatives. The
surviving reason — **a customer must never hold a Neon credential**, because a customer who holds
one can reach their database after we suspend them — was always sufficient to justify a port. It was
only insufficient against a fourth Auto Scaling group.

The binary stays too, on the same footing as `valkey-proxy`'s and `search-proxy`'s: useful for
driving one protocol in isolation, and nothing deploys it.

**What this does not change.** (2) and (3) are still gone. Managed Neon wakes its own endpoints —
measured at 0.24 seconds to disable one — and ships PgBouncer in front of every endpoint. The
listener does tenant authentication and suspension enforcement, and nothing else.
