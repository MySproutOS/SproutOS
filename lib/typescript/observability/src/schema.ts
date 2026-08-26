import { clickhouse } from "./client"
import { RUNTIME_LOG_RETENTION_DAYS } from "./runtime-logs"

export const USAGE_EVENT_RAW_TABLE = "usage_event_raw"
export const USAGE_EVENT_QUEUE_TABLE = "usage_event_queue"
export const USAGE_EVENT_MATERIALIZED_VIEW = "usage_event_mv"

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
/**
 * Runtime logs from customers' Lambda functions.
 *
 * A separate table from `log_record`, deliberately. `log_record` is the OpenTelemetry model a
 * customer's own exporter writes into, with a per-row retention their plan sets. These are lines
 * Lambda emitted whether the customer asked or not, they have Lambda's own billing fields on them,
 * and they expire in three days for everyone. One table carrying both would need every OTel column
 * nullable and a retention expression covering two unrelated policies.
 *
 * **Kept in step with `ovh/clickhouse-init/01-runtime-logs.sql` by being the same statement.** That
 * file seeds a fresh box; this runs on every boot. A schema that existed in only one of the two is
 * a schema that differs between the machine it was tested on and the one it runs on.
 */
const RUNTIME_LOG_DDL = `
create table if not exists runtime_log (
  ts DateTime64(3) CODEC(Delta, ZSTD(1)),
  project_id UUID,
  deployment_id UUID,
  request_id String CODEC(ZSTD(1)),
  level LowCardinality(String),
  message String CODEC(ZSTD(3)),
  duration_ms Nullable(Float32),
  billed_ms Nullable(UInt32),
  memory_mb Nullable(UInt16),
  init_ms Nullable(Float32),
  cold_start Nullable(Bool)
)
engine = MergeTree
partition by toDate(ts)
order by (project_id, ts, request_id)
ttl toDateTime(ts) + toIntervalDay(${RUNTIME_LOG_RETENTION_DAYS}) delete
settings index_granularity = 8192, ttl_only_drop_parts = 1
`

/*
  A token bloom filter, not a full text index.

  Searching message text is the point of a log viewer, and a full scan of three days of one
  project's logs is not fast enough. ClickHouse's own benchmark measures a full text index at 215
  GiB against 7 GiB for this on the same corpus.
*/
const RUNTIME_MESSAGE_INDEX_DDL = `
alter table runtime_log
  add index if not exists message_tokens message type tokenbf_v1(32768, 3, 0) granularity 4
`

/**
 * The Kafka side of the runtime log path.
 *
 * A `Kafka` engine table is a *consumer*, not storage: selecting from it takes messages off the
 * topic and they are gone. Nothing reads it directly — the materialized view below is the only
 * consumer, and it writes into `runtime_log`, which is the table anything else queries.
 *
 * **Why Kafka is in the path at all.** The obvious shape is to insert straight into ClickHouse from
 * whatever ships the logs. That gives one small `INSERT` per batch, which is ClickHouse's worst
 * write pattern — every insert is a part, and a part per second per busy project is merge pressure
 * that eventually stalls writes. It also has nowhere to put the lines when ClickHouse is briefly
 * unreachable, and no way to replay after a parsing bug. Kafka is a disk-backed buffer that solves
 * all three, and it is already on the OVH box.
 */
function runtimeLogQueueDdl(brokers: string, topic: string): string {
  /*
    Interpolated, not bound.

    ClickHouse does not substitute query parameters inside a `settings` clause — it answers a
    `{brokers: String}` there with a bare SYNTAX_ERROR naming no setting. So these are checked
    against a strict shape instead: both come from the environment rather than from a request, but
    "it is not user input" is the reasoning behind every injection that ever shipped, and a
    `KAFKA_BROKERS` set from a badly-escaped deploy variable is a real way to get a quote in here.
  */
  if (!/^[A-Za-z0-9._-]+:\d+(,[A-Za-z0-9._-]+:\d+)*$/.test(brokers)) {
    throw new Error(`KAFKA_BROKERS is not a host:port list: ${JSON.stringify(brokers)}`)
  }
  if (!/^[A-Za-z0-9._-]{1,249}$/.test(topic)) {
    throw new Error(`KAFKA_RUNTIME_LOG_TOPIC is not a Kafka topic name: ${JSON.stringify(topic)}`)
  }

  return `
create table if not exists runtime_log_queue (
  ts DateTime64(3),
  project_id UUID,
  deployment_id UUID,
  request_id String,
  level LowCardinality(String),
  message String,
  duration_ms Nullable(Float32),
  billed_ms Nullable(UInt32),
  memory_mb Nullable(UInt16),
  init_ms Nullable(Float32),
  cold_start Nullable(Bool)
)
engine = Kafka
settings
  kafka_broker_list = '${brokers}',
  kafka_topic_list = '${topic}',
  kafka_group_name = 'clickhouse-runtime-log',
  kafka_format = 'JSONEachRow',
  -- One malformed message must not stop the consumer. Without this a single bad line wedges the
  -- whole topic and every project's logs stop, which is a far worse failure than losing one line.
  kafka_skip_broken_messages = 100,
  -- Batch on the consumer rather than per message: the point of Kafka here is that ClickHouse gets
  -- large inserts instead of a part per log line.
  kafka_max_block_size = 65536
`
}

/**
 * The only consumer of the queue, writing into the table everything else reads.
 *
 * A materialized view in ClickHouse is an insert trigger, not a cached query — rows arriving in
 * `runtime_log_queue` are pushed through this into `runtime_log` as they are consumed.
 */
const RUNTIME_LOG_MV_DDL = `
create materialized view if not exists runtime_log_mv to runtime_log as
select ts, project_id, deployment_id, request_id, level, message,
       duration_ms, billed_ms, memory_mb, init_ms, cold_start
from runtime_log_queue
`

/**
 * Durable, unaggregated usage as received from the metering pipeline.
 *
 * Kafka delivery is deliberately at least once. A consumer can insert a block and lose its offset
 * acknowledgement, so the same event may arrive again. `ReplacingMergeTree(version)` makes those
 * copies converge during background merges; it does not make an ordinary SELECT immediately
 * unique. Any financial read must use `FINAL` or group by `event_id` with `argMax(..., version)`.
 *
 * `event_id` and `version` are computed by the producer and are deterministic across retries:
 * `event_id` is a lowercase SHA-256 hex string over the event identity, and `version` is
 * `ingested_at` as epoch milliseconds. They are carried through unchanged rather than regenerated
 * here, because a replay after a process restart must name the same row and version.
 */
export function usageEventRawDdl(database = ""): string {
  const table = qualified(database, USAGE_EVENT_RAW_TABLE)

  return `
create table if not exists ${table} (
  event_id String,
  organization_id UUID,
  project_id Nullable(UUID),
  resource_type LowCardinality(String),
  resource_id Nullable(UUID),
  dimension LowCardinality(String),
  quantity Decimal(38, 9),
  occurred_at DateTime64(3, 'UTC'),
  window_start Nullable(DateTime64(3, 'UTC')),
  window_end Nullable(DateTime64(3, 'UTC')),
  node_id Nullable(String),
  pod_uid Nullable(String),
  source String,
  external_id String,
  charged_externally Bool,
  attributes Map(String, String),
  ingested_at DateTime64(3, 'UTC'),
  stored_at DateTime64(3, 'UTC') default now64(3, 'UTC'),
  version UInt64,
  constraint usage_event_id_is_sha256 check match(event_id, '^[0-9a-f]{64}$')
)
engine = ReplacingMergeTree(version)
partition by toYYYYMM(occurred_at)
order by event_id
settings index_granularity = 8192
`.trim()
}

/** Keep an already-created raw table compatible when the importer watermark is introduced. */
export function usageEventStoredAtDdl(database = ""): string {
  return `alter table ${qualified(database, USAGE_EVENT_RAW_TABLE)} add column if not exists stored_at DateTime64(3, 'UTC') default now64(3, 'UTC')`
}

/** The JSONEachRow consumer for normalized, one-event-per-message usage records. */
export function usageEventQueueDdl(brokers: string, topic: string, database = ""): string {
  validateKafkaLocation(brokers, topic, "KAFKA_USAGE_EVENT_TOPIC")
  const table = qualified(database, USAGE_EVENT_QUEUE_TABLE)

  return `
create table if not exists ${table} (
  event_id String,
  organization_id UUID,
  project_id Nullable(UUID),
  resource_type LowCardinality(String),
  resource_id Nullable(UUID),
  dimension LowCardinality(String),
  quantity Decimal(38, 9),
  occurred_at DateTime64(3, 'UTC'),
  window_start Nullable(DateTime64(3, 'UTC')),
  window_end Nullable(DateTime64(3, 'UTC')),
  node_id Nullable(String),
  pod_uid Nullable(String),
  source String,
  external_id String,
  charged_externally Bool,
  attributes Map(String, String),
  ingested_at DateTime64(3, 'UTC'),
  version UInt64
)
engine = Kafka
settings
  kafka_broker_list = '${brokers}',
  kafka_topic_list = '${topic}',
  kafka_group_name = 'clickhouse-usage-event-v1',
  kafka_format = 'JSONEachRow',
  kafka_max_block_size = 65536
`.trim()
}

/** The insert trigger that moves consumed Kafka messages into durable storage. */
export function usageEventMaterializedViewDdl(database = ""): string {
  const view = qualified(database, USAGE_EVENT_MATERIALIZED_VIEW)
  const destination = qualified(database, USAGE_EVENT_RAW_TABLE)
  const source = qualified(database, USAGE_EVENT_QUEUE_TABLE)

  return `
create materialized view if not exists ${view} to ${destination} as
select event_id, organization_id, project_id, resource_type, resource_id, dimension, quantity,
       occurred_at, window_start, window_end, node_id, pod_uid, source, external_id,
       charged_externally, attributes, ingested_at, now64(3, 'UTC') as stored_at, version
from ${source}
`.trim()
}

function qualified(database: string, table: string): string {
  if (database === "") return table
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error(`ClickHouse database is not an identifier: ${JSON.stringify(database)}`)
  }
  return `${database}.${table}`
}

function validateKafkaLocation(brokers: string, topic: string, topicVariable: string): void {
  if (!/^[A-Za-z0-9._-]+:\d+(,[A-Za-z0-9._-]+:\d+)*$/.test(brokers)) {
    throw new Error(`KAFKA_BROKERS is not a host:port list: ${JSON.stringify(brokers)}`)
  }
  if (!/^[A-Za-z0-9._-]{1,249}$/.test(topic)) {
    throw new Error(`${topicVariable} is not a Kafka topic name: ${JSON.stringify(topic)}`)
  }
}

/** Where the log topic lives. Absent means this deployment does not consume from Kafka. */
export function kafkaConfigured(): boolean {
  return (process.env.KAFKA_BROKERS ?? "") !== ""
}

export async function ensureSchema(): Promise<void> {
  const client = clickhouse()
  await client.command({ query: LOG_RECORD_DDL })
  await client.command({ query: BODY_INDEX_DDL })
  await client.command({ query: RUNTIME_LOG_DDL })
  await client.command({ query: RUNTIME_MESSAGE_INDEX_DDL })
  await client.command({ query: usageEventRawDdl() })
  await client.command({ query: usageEventStoredAtDdl() })

  /*
    The consumer, only where there is a broker to consume from.

    A `Kafka` engine table pointed at a broker that does not exist logs a connection error on a
    timer forever, so a developer with no Kafka should not have one. The view is created with it or
    not at all: a view whose source table is missing is a `DROP`-time error nobody expects.
  */
  if (!kafkaConfigured()) return

  await client.command({
    query: runtimeLogQueueDdl(
      process.env.KAFKA_BROKERS ?? "",
      process.env.KAFKA_RUNTIME_LOG_TOPIC ?? "runtime-logs",
    ),
  })
  await client.command({ query: RUNTIME_LOG_MV_DDL })
  await client.command({
    query: usageEventQueueDdl(
      process.env.KAFKA_BROKERS ?? "",
      process.env.KAFKA_USAGE_EVENT_TOPIC ?? "usage-events",
    ),
  })
  await client.command({ query: usageEventMaterializedViewDdl() })
}
