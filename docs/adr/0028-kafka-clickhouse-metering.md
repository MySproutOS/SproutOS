# 0028. Kafka and ClickHouse are the durable raw metering path

- Status: Accepted; production verification pending
- Date: 2026-08-26
- Supersedes: [0014](0014-one-metering-pipeline.md) raw storage and delivery
- Preserves: 0014's signed ingest contract and separation of billing from lossy telemetry

## Context

ADR 0014 chose Postgres `usage_event` as the only raw billing store. The table was range
partitioned by day, but its migration created children only from the previous day through seven
days ahead. No scheduler created the next partition. Once that fixed window elapsed, every insert
failed; the proxy caller logged and discarded failed batches.

The replacement also has to serve two different needs without confusing them. The dashboard and
limit checks need a low-latency current counter. Financial history needs acknowledged, replayable
events and fast scans over a stream that grows forever. Valkey is suited to the first and is not a
durable ledger; ClickHouse is suited to the second.

This decision continues two earlier records rather than erasing them:

- `private_notes/groups.md` is the verbatim requirements/reporting record for the deployment and
  sandbox program. Its production claims remain historical evidence, not evidence for this cutover.
- `private_notes/sandbox-handoff.md` records that the sandbox work was exercised through Docker,
  not Daytona. Nothing in this ADR upgrades that evidence to Daytona verification.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` remains the legacy product
  deployment plan and its "What actually happened" report.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` is the hardening plan that found the
  partition deadline and defines the wider dimension, isolation, and enforcement work. This ADR
  supersedes C0's proposed permanent Postgres partition scheduler; it does not claim the rest of
  Parts A, B, or C complete.

## Decision

One normalized event contract feeds two projections:

```text
trusted producer
  -> Kafka usage-events (acks=all, stable event_id)
      -> ClickHouse usage_event_raw (ReplacingMergeTree(version))
      -> Valkey fixed-point current counters (event-id idempotency)

ClickHouse absolute minute/hour/day totals
  -> Postgres usage_rollup
  -> rating, statements, and charging
```

The signed HTTP ingest returns success only after Kafka acknowledges and the Valkey projection
lands. Retrying is safe at both destinations. TypeScript operations that already own a Postgres
transaction—agent settlement and sandbox watermark advancement—write the exact Kafka payload to
`metering_outbox` in that same transaction. A relay publishes and projects it before deleting the
row. A crash may repeat an event and may not lose one.

`usage_event_raw FINAL` is the financial raw view. A ClickHouse storage-time watermark discovers
late arrivals independently of their event timestamp. The importer recomputes absolute affected
grains and advances its Postgres cursor in the same transaction as the rollup changes. A corrected
event that moves grains emits zero for its old grain, so stale quantity cannot remain billable.

Valkey quantities use integer nano-units, never floating-point increments. It is the current usage
view used for prompt feedback and enforcement; it is not charged directly. Postgres keeps durable
financial rollups and the credit ledger, not raw events.

The canonical dimension list is a shared fixture asserted by Rust and TypeScript. Raw Postgres
`usage_event`, its partitions, and the additive `rollUpUsage` job are removed. Existing billing
history is intentionally not migrated: production has no customer history that must be preserved.

## Consequences

- Kafka and ClickHouse availability are billing-path dependencies and their importer must fail
  visibly when unconfigured. A green no-op is lost revenue.
- Kafka delivery is at least once. Every financial ClickHouse query must deduplicate with `FINAL`
  or an equivalent `argMax` by stable event id and version.
- ClickHouse's Kafka credential is server-side configuration. It must not appear in table DDL or
  query logs. The current OVH consumer uses its private plaintext listener; a remote consumer uses a
  distinct read-only SCRAM identity.
- The TypeScript outbox may hold Postgres row locks while waiting for bounded Kafka and Valkey
  acknowledgements. This is deliberately bounded and observable; a future lease state can reduce
  lock duration without changing delivery semantics.
- ClickHouse backup, restore drills, every remaining dimension emitter, and limit enforcement are
  separate rollout requirements. This ADR does not call them deployed merely because the raw path
  exists in code.
- Daytona sandbox verification and the LLM proxy's real OAuth/model call remain governed by the
  sandbox handoff. They are not implied by Docker or stub-provider tests.

## Alternatives considered

**Keep extending Postgres partitions.** A scheduler would remove the immediate deadline, but leaves
an append-forever hot event store beside transactional control-plane data and does not provide the
write throughput or analytical scan shape this stream needs.

**Valkey as the only meter.** Rejected because eviction, failover, and TTL are valid cache behavior
and invalid financial-history behavior.

**Write ClickHouse directly from every producer.** Rejected because it gives every process a
database credential, lacks a replay buffer, and cannot atomically accompany a Postgres settlement
or watermark.

**Reuse runtime-log Kafka credentials and tables.** Rejected because logs are allowed to be lossy
and a compromised log producer must not be able to write billing events. The topics, principals,
consumer groups, and raw tables remain separate.
