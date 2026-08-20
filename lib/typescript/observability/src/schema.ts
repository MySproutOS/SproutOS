import { clickhouse } from "./client"

/**
 * The log table.
 *
 * Modelled on the OpenTelemetry log data model rather than on something of our own, because the
 * whole point of TASK 34 is that a customer points an existing OTel exporter at us. A schema that
 * did not have somewhere to put `trace_id` or `severity_number` would force a translation layer,
 * and translation layers lose the fields nobody thought about.
 *
 * `ORDER BY (project_id, timestamp)` — every query is scoped to one project, so the primary key
 * puts one tenant's data contiguously on disk and a query reads only its own granules.
 *
 * `PARTITION BY toDate(timestamp)` — a day per partition, which is what makes retention a metadata
 * operation. Dropping a partition is instant; deleting rows is a mutation that rewrites parts.
 *
 * The TTL reads `retention_days` **from the row**, so a project on the 7-day plan and one on the
 * 90-day plan can share the table. Storing it per row rather than per table is what avoids a table
 * per retention tier — and a migration every time someone changes plan.
 */
const LOG_RECORD_DDL = `
create table if not exists log_record (
  project_id UUID,
  organization_id UUID,
  timestamp DateTime64(9),
  observed_timestamp DateTime64(9),
  severity_number UInt8,
  severity_text LowCardinality(String),
  body String,
  trace_id String,
  span_id String,
  service_name LowCardinality(String),
  scope_name LowCardinality(String),
  attributes Map(String, String),
  resource_attributes Map(String, String),
  retention_days UInt16,
  ingested_at DateTime default now()
)
engine = MergeTree
partition by toDate(timestamp)
order by (project_id, timestamp)
ttl toDateTime(timestamp) + toIntervalDay(retention_days)
settings index_granularity = 8192
`

/**
 * A skip index on the body.
 *
 * "Find the request that failed" is a substring search, and without this every such query reads
 * every granule in the time range. A token bloom filter lets ClickHouse skip granules that cannot
 * contain the term. It only helps whole-token matches — a search for `time` will not skip on a body
 * containing `timeout` — which is the honest limit of what a log store gives you before it becomes
 * a search engine, and TASK 33 is where that lives.
 */
const BODY_INDEX_DDL = `
alter table log_record
  add index if not exists log_record_body_tokens body type tokenbf_v1(32768, 3, 0) granularity 4
`

/**
 * Creates the schema if it is not there.
 *
 * Idempotent and safe to run on every boot: this is a store whose schema is small, versionless, and
 * owned entirely by this package, so a migration runner would be ceremony around two statements.
 */
export async function ensureSchema(): Promise<void> {
  const client = clickhouse()
  await client.command({ query: LOG_RECORD_DDL })
  await client.command({ query: BODY_INDEX_DDL })
}
