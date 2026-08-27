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

One normalized event contract currently reaches two projections through the producer:

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

Valkey quantities use integer nano-units, never floating-point increments. It is the rebuildable
current usage view for prompt feedback and enforcement; it is not charged directly. An hourly job
builds a blank generation from bounded, keyset-paginated `FINAL` rows, then atomically changes the
reader pointer. Synchronous writers dual-write while a generation is building, compare decimal
ClickHouse versions before replacing contributions, and retain a bounded pending view until
ClickHouse acknowledges that version. An older rebuild therefore cannot overwrite concurrent
ingest, and partial eviction converges without mutating a live total in place. Postgres keeps
durable financial rollups and the credit ledger, not raw events. [Finding 0036](../findings/0036-the-fast-usage-view-was-write-only.md)
records both the original gap and the repaired boundary.

The canonical dimension list is a shared fixture asserted by Rust and TypeScript. Raw Postgres
`usage_event`, its partitions, and the additive `rollUpUsage` job are removed. Existing billing
history is intentionally not migrated: production has no customer history that must be preserved.

Site metering uses the router's durable filesystem spool before joining this pipeline. The
TypeScript-minted log token now signs both project and organization; the extension body can choose
neither. Once the router verifies that token, each complete Lambda `platform.report` becomes one
`site_request` event and one `site_gib_second` event using Lambda's billed duration and configured
memory. The Lambda API response's request id identifies `site_egress_byte` at the decoded response
body boundary. External ids and observation timestamps are written once into the fsynced record,
so an HTTP timeout and replay cannot restamp or double-bill them.
Existing project-only log tokens remain valid for logs during rollout, but cannot emit usage; the
next project deployment replaces them with the organization-bound shape rather than guessing a
billing owner for an old credential.

`workflow_job_enqueued` is emitted through the same transactional outbox as the workflow run and
its planned steps, as one aggregate event whose quantity is the exact step count. This corrects
the legacy hardening plan's proposed dispatcher boundary: the Valkey master wake set deliberately
coalesces many enqueues into one queue activation, and a worker invocation may drain up to 25, so
the dispatcher cannot honestly count jobs. Per-run queue bytes and dwell remain null because the
service-level residency sampler below cannot attribute either value to one workflow run; the API
marks their absence as incomplete rather than showing zero.

Valkey residency is sampled from the privileged control plane, never from tenant-visible `SCAN`.
Each pass forces the exact engine prefix, sums `MEMORY USAGE ... SAMPLES 0` for only those keys,
and transactionally advances a per-service observation beside its outbox event. Byte-seconds are
the trapezoidal integral between adjacent successful five-minute observations. This is explicitly a
sampled estimate, not command-by-command accounting: a first observation establishes the baseline,
and a gap longer than one period plus a one-minute scheduling tolerance resets it without billing
the missing interval. The system would rather lose that interval than invent residency it did not
observe.

This does not pretend metering can take the front door down. If the bounded spool is full or cannot
be opened, the router logs the unrecorded observation and serves the tenant response. That is an
explicit availability-over-revenue failure mode, matching credit enforcement's fail-open rule;
silently turning capacity exhaustion into a 500 would make a billing outage a customer outage.

Search metering uses the same durable handoff in its own spool. A query is observed only after a
successful response arrives from OpenSearch, before the response body is returned to the caller;
this counts work the engine accepted even if the caller then disconnects. `_msearch` counts its
individual header/body pairs. At the next UTC hour boundary, the proxy enumerates internal users
carrying the platform ownership marker and authenticates as each tenant user to read primary-store
bytes from that user's namespace-scoped `_stats`. The resource/hour external id converges across
router replicas, and the stored timestamp is the original hour boundary. Missing metering capacity
is logged and fails open rather than changing the tenant's search result.

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
- Valkey is not a second durable usage store. Its generations expire, ClickHouse supplies every
  rebuild row, and billing never reads the cache. Reconciliation bounds organization, event,
  pending, page, and cleanup cardinality; exceeding a bound fails the visible background job
  instead of starting an unbounded scan. Prompt feedback and quota enforcement remain separate
  consumers and must read only through the atomic generation pointer.
- ClickHouse backup and poison-message handling are implemented in the repository: native backups
  use a restricted env-credentialed S3 disk, scheduled health checks make stale/failed backups and
  DLQ rows red, and a restore drill verifies an embedded snapshot manifest. They remain
  **production verification pending** until the bucket is applied, the runtime-only key is placed
  on OVH, the initial backup succeeds, and the restore drill passes there. Every remaining
  dimension emitter and limit enforcement are still separate rollout requirements.
- Daytona sandbox verification and the LLM proxy's real OAuth/model call remain governed by the
  sandbox handoff. They are not implied by Docker or stub-provider tests.
- `site_request` and `site_gib_second` become durable only after a verified report reaches the
  router. The Lambda extension and its in-memory delivery remain fail-open to protect customer
  invocations, so a process death before delivery can still lose that observation. Production must
  not describe these dimensions as lossless until that pre-router gap is closed or measured.

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
