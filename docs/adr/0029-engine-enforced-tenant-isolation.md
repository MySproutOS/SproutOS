# 0029. Tenant search and queues have engine-enforced identities

- Status: Accepted; production verification pending
- Date: 2026-08-26
- Extends: [0026](0026-aws-only-lambda-and-two-rust-proxies.md)

## Context

The router's Valkey and OpenSearch splits authenticate a tenant and rewrite names into a tenant
namespace. Rewriting is useful but cannot be the final security boundary: a command or request body
shape the proxy does not understand can name data without putting that name in the URL. The engines
therefore also need one restricted identity per backend service.

This decision is the implementation record for Part A and Part B4 of
`/Users/andrew/.claude/plans/double-sorted-meteor.md`. It does not rewrite the historical evidence:

- `private_notes/groups.md` is the original requirements and deployment report.
- `private_notes/sandbox-handoff.md` records which sandbox claims were exercised through Docker,
  not Daytona.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` remains the legacy deployment
  plan and its report of what actually happened.

## Decision

The OpenSearch proxy authenticates upstream as a matching internal user with an HMAC-derived,
unstored password. Its role grants the exact tenant index pattern plus the action groups required by
the proxy's route table. A missing cached identity is repaired lazily; one upstream 401 invalidates
the cache, recreates the role, user, and mapping, and retries exactly once.

The existing hourly jobs path also reconciles every non-deleted Elasticsearch service against the
three Security documents. It separately reports missing, drifted, repaired, and orphaned counts,
plus list and repair latency. Repairs are bounded to 100 documents per pass because every Security
write reloads configuration. Unknown orphan-shaped documents are reported but never deleted by the
reconciler: the deletion reaper is the path that has a soft-deleted Postgres row proving ownership.

Valkey follows the same lifecycle with one ACL user per live queue service. The router performs a
60-second-bounded startup pass after its administrator self-check, and the jobs path repeats a
bounded pass hourly. Missing users and a rotating window of drifted users are repaired from the
HMAC root; tenant-shaped unknown users are counted but not deleted. The established service reaper
remains the only path allowed to delete an ACL user because it carries deletion proof.

The operational cardinality soft limit is **1,000 tenant identities**. It is a warning, not a
provisioning refusal. The job keeps serving and emits `soft_limit_exceeded=true`; an operator then
decides whether to raise the measured limit or change the topology.

## Measurement

Measured locally on 2026-08-26 against the repository's secured OpenSearch 2.19.0 ARM64 container,
512 MiB JVM heap, using `bin/measure-opensearch-security-cardinality.mjs`. The harness created one
role, internal user, and mapping for each of 1,000 synthetic tenants using 250-document Security API
PATCH batches, measured, then verified cleanup of every benchmark-prefixed document.

| At 1,000 identities        |                          Result |
| -------------------------- | ------------------------------: |
| Add roles                  |                        2,068 ms |
| Add internal users         |                       13,620 ms |
| Add role mappings          |                       18,991 ms |
| List roles                 |          434 ms / 307,839 bytes |
| List internal users        |           50 ms / 227,665 bytes |
| List role mappings         |           45 ms / 188,110 bytes |
| Authenticate the last user |                          413 ms |
| JVM heap used / committed  | 170,351,816 / 536,870,912 bytes |

The 1,000 mark is deliberately the soft threshold because it is the highest measured cardinality,
and authentication was already hundreds of milliseconds on the small development heap. The plan's
10,000 and 100,000 tiers are not represented as safe: they remain unmeasured. Run the same guarded
harness on a disposable production-shaped node before raising the threshold. Production itself has
not been load-tested or verified by this measurement.

Valkey's 1,000/10,000/100,000 local measurements and exact disposable-engine harness are recorded
in [the Valkey ACL cardinality report](../benchmarks/valkey-acl-cardinality.md). They are explicitly
development evidence, not ElastiCache or production verification.

## Consequences

- Drifted-open OpenSearch roles are repaired without waiting for tenant traffic.
- Initial or widespread drift becomes a bounded backlog (`pending_repairs`) rather than an
  unbounded job lease.
- Cardinality, reload time, and list time are visible in hourly job logs.
- Valkey ACL list/repair latency, missing/drifted/orphaned counts, and repair backlog are visible in
  both startup and hourly logs.
- The soft limit can be overridden with `SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT`, but changing it
  without a recorded measurement defeats the purpose of the limit.
- More than one OpenSearch node, a larger heap, a Security plugin upgrade, or an authentication
  backend change invalidates this measurement and requires another run.
