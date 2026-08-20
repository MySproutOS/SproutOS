# @lib/observability

The observability service: OTLP ingest, log storage, and search.

> TASK 34: We need an observability service that takes in logs from all the different projects. It
> is like open telemetry.

Not _like_ OpenTelemetry — **it speaks OTLP**. A customer points an exporter they already have at
one endpoint and their logs arrive. Anything else would mean writing an SDK per language, and then
a translation layer, and translation layers lose the fields nobody thought about.

## ClickHouse, not Postgres

A log store is append-mostly, queried by time range and by a handful of low-cardinality columns, and
thrown away after days rather than kept forever. That is exactly the shape a columnar store with a
TTL is for. The same volume in Postgres is a table nobody can vacuum and an index that does not fit
in memory.

## The schema

Modelled on the OpenTelemetry log data model rather than on something of our own, so there is
somewhere to put `trace_id` and `severity_number` without inventing a mapping.

- **`ORDER BY (project_id, timestamp)`** — every query is scoped to one project, so one tenant's
  data sits contiguously and a query reads only its own granules.
- **`PARTITION BY toDate(timestamp)`** — a day per partition, which makes retention a metadata
  operation. Dropping a partition is instant; deleting rows is a mutation that rewrites parts.
- **`TTL toDateTime(timestamp) + toIntervalDay(retention_days)`** — the retention is read **from the
  row**, so a project on the 7-day plan and one on the 90-day plan share a table. Per-table
  retention would mean a table per tier and a migration every time someone changes plan.

Resource attributes are denormalized onto every record. Logs are read by time range and dropped by
TTL, so a join to a resource table would make every query pay for normalization that nothing ever
updates.

## Two things the parser gets right that are easy to get wrong

**`timeUnixNano` is a string, and has to stay one.** 2^53 nanoseconds ran out in 1970 plus a hundred
days, so every real timestamp is past the point where a JavaScript number is exact. Anything that
touches it as a `number` silently rounds a customer's timestamps — `1735689600123456789` becomes
`1735689600123456800`. It is handled as `bigint` end to end, and the cursor a client pages with is
the nanosecond count rather than a formatted datetime, so it round-trips exactly.

**snake_case is legal.** The protobuf JSON mapping says a parser must accept both spellings, and
SDKs differ. Accepting only `camelCase` silently drops records from whichever half of the ecosystem
we did not happen to test against.

## Ownership comes from the key, never from the payload

`project_id`, `organization_id` and `retention_days` are stamped from the **resolved stream**. A
tenant that could name its own project id in an OTLP attribute could write into another tenant's
logs; one that could name its own retention could keep data forever on the cheapest plan. There is a
test that sends all three as attributes and asserts they are ignored.

## The ingest key

`sos_ing_` followed by 256 bits of base64url. The prefix is there so a key found in a log file or a
git history is identifiable at a glance — the point of a prefix on a secret is that a scanner, or a
person, can tell what leaked without having to try it.

Stored as **plain SHA-256**, for the same reason the queue credentials are: nobody chose this secret,
so there is nothing for a work factor to make expensive, and the ingest endpoint verifies once per
batch — a hot path where 19 MiB of Argon2 is a denial-of-service lever rather than a defence.

Shown once. There is no route that reads it back, because the hash is one-way; rotating is the only
way to replace it, and rotating invalidates the old key immediately. That is what makes it a
recovery from a leak rather than a convenience.

**Rotating needs `observability:stream:manage`, not `observability:logs:read`.** It stops every
exporter the project has deployed until each is redeployed with the new key, so a member can read
logs and cannot rotate.

## Why the endpoint path looks doubled

`/v1/otlp/v1/logs`. An OTel exporter appends `/v1/logs` to whatever endpoint it is given, so what a
customer configures is:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.sproutos.dev/v1/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer sos_ing_...
```

and nothing else. Inventing a path of our own would mean every customer setting
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` explicitly, which is the setting people get wrong.

## Partial success is not optional

OTLP requires a server that drops records to say how many. A bare 200 leaves the exporter with no
way to know its telemetry is not arriving — a bad failure for a product whose whole job is telling
you what happened. `rejectedLogRecords` is a string because it is an int64 in the protobuf.

## Batching happens on the server

`async_insert = 1`. A tenant's exporter sends small batches often, and one INSERT per batch on a
MergeTree creates one part per batch — thousands of tiny parts for the merge scheduler to work
through, which is the classic way to make ClickHouse fall over.

`wait_for_async_insert = 1`, so the endpoint does not acknowledge a batch until it is durable.
Acknowledging earlier would be faster and would mean telling a customer their logs were stored when
they might not be.

## Search is a substring match, not a token match

The body carries a `tokenbf_v1` skip index, which lets ClickHouse skip granules that cannot contain
a term — but only for whole tokens. A person searching a log box types `timeout`, and the line reads
`connect_timeout=30`. `hasToken` misses that, and a search box that quietly required token
boundaries looks broken rather than slow. So the predicate is `positionCaseInsensitive`, which is
slower in the worst case and correct in every case. Real full-text search is TASK 33.

## Testing

```bash
docker compose up -d clickhouse
pnpm --filter=@lib/observability exec vitest run
```

`otlp.test.ts` is pure and runs anywhere — the parser is where telemetry is silently dropped or
mangled, and neither failure produces an error anyone sees.

`store.test.ts` runs against the compose ClickHouse, because what is being tested is agreement with
ClickHouse: that the DDL is accepted, that a `DateTime64(9)` returns the nanoseconds it was given,
that a `Map(String, String)` comes back as an object, and that a query scoped to one project cannot
reach another's rows.

Both skip on a developer's machine when the store is absent and **throw in CI**, because a skipped
isolation test looks exactly like a passing one in the summary.

## Not built yet

- **Traces and metrics.** The schema and the endpoint are logs-only. `/v1/traces` and `/v1/metrics`
  are the same shape of work against different data models, and TASK 34 asks for logs.
- **Protobuf.** Only `http/json` is accepted, and an exporter defaulting to protobuf is told so
  explicitly rather than left with a parse error that reads like a bug in its own code.
- **Node-level collection.** A customer's container writing to stdout is not collected; they have to
  export. Scraping stdout on the metal nodes is phase 11's work and needs the DaemonSet.
- **Billing.** `usage_event` has no dimension for ingested bytes yet, so `projectUsage` answers the
  dashboard and nothing bills from it.
