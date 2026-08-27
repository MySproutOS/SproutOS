# 0014. One metering pipeline; money never rides the telemetry path

- Status: Superseded by [0028](0028-kafka-clickhouse-metering.md)
- Date: 2026-08-20

## Context

Two areas built two complete, incompatible metering pipelines — two agents, two tables, two ingest
endpoints, two auth schemes — and a third area forbids one of them.

The billing notes: "A billing DaemonSet reads **cAdvisor** `container_cpu_usage_seconds_total` …
and POSTs HMAC-signed batches with `external_id = {node_id}:{pod_uid}:{window_start}`" →
`POST /api/v1/internal/metering/events` → `usage_event`, authenticated by
`METERING_INGEST_HMAC_KEY`. That area states the principle: "**Prometheus is observability, not the
billing path** — scrape gaps silently lose revenue and, worse, silently overcharge on counter
resets."

The compute notes: "a DaemonSet on each metal node reads **cgroup v2** per pod at 1 Hz …
agent → OTLP → node-local OTel Collector → Kinesis → aggregator → `POST /api/v1/internal/usage/samples`
→ `compute_usage_sample`", with "**this is the only table the billing meter reads**", mTLS + IRSA,
and `METERING_INGEST_TOKEN`.

The data-plane notes then rule on the disagreement without knowing they were doing so, Decision 14:
"**Billing usage events are a SEPARATE path from the log pipeline.** Telemetry is lossy-by-design
(batching, tail sampling, memory_limiter drops); money must not be."

## Decision

One pipeline:

```
services/metering-agent (Rust DaemonSet, cgroup v2, 1 Hz)
  → HMAC-signed batch (lib/rust/metering-proto)
  → POST /api/v1/internal/metering/events
  → usage_event
```

`compute_usage_sample` is deleted; `usage_event` is the only table the rating job reads. The OTel
collector carries telemetry only, and may emit a cheap count/bytes metric for _display_, never for
billing.

## Consequences

- The agent is Rust, in `services/metering-agent`. It wakes once a second per pod on every metal
  node; a Node process doing that is paying GC pauses and an event-loop hop for pure byte-shuffling,
  on the most expensive hardware we own.
- The event schema and its HMAC signing live in `lib/rust/metering-proto` and are consumed by the
  TypeScript ingest route. One set of fixture vectors, asserted from both sides, or the seam rots.
- Ingest is idempotent on `(source, external_id)` with `external_id = {node_id}:{pod_uid}:{window_start}`.
  A node reboot re-sends the batch; the unique constraint absorbs it.
- **TASK 24's real requirement is that one VM hosts multiple projects.** Both source designs mapped
  `pod_uid` to a single id. The sample therefore carries a `project_id` **split key**, not a column,
  and the ingest route fans one sample into per-project events.
- Counter resets must be clamped: a container restart resets the CPU counter, and a naive delta
  produces a giant bogus charge. Clamp negative deltas to the new absolute value and cap any window
  at `window_seconds × pod_cpu_limit`.
- Dimensions must cover what the agent actually emits. The billing enum gains active-CPU,
  provisioned-memory, and websocket-connection-seconds dimensions, which the compute design measured
  but had nowhere to land.
- One environment variable, `METERING_INGEST_HMAC_KEY`. Kinesis leaves the billing path entirely.

## Superseded, 2026-08-26

The decision to keep money off the lossy observability path still stands. The Postgres
`usage_event` implementation does not: its daily partitions were created only once by the initial
migration, so the accepted pipeline had a built-in end date. ADR 0028 preserves the signed ingest
contract and replaces the raw store with Kafka and ClickHouse.

The router's later `platform.report` converter does not make ClickHouse runtime-log rows a billing
source. It verifies an organization-and-project token, constructs usage immediately, and hands it
to the separate fsynced metering spool. ADR 0028 records the remaining pre-router loss window in
the extension rather than calling a fail-open telemetry hop durable.

## Alternatives considered

**OTLP → Kinesis → aggregator** (the compute design). Buys backpressure and replay. Rejected: every
component on that path is allowed to drop data under memory pressure, and the failure is silent
revenue loss.

**Both pipelines, reconciled nightly.** Rejected: two sources of truth for money is not a design, it
is a reconciliation project.
