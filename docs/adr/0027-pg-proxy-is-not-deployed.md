# 27. `pg-proxy` is built, tested, and not deployed

**Status:** accepted, and reversible in one commit
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
