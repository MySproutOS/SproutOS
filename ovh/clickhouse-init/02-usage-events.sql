-- Durable raw usage events. Kafka is intentionally at-least-once: a block may be inserted before
-- its consumer offset is committed, so retries can produce duplicate rows. ReplacingMergeTree
-- converges those copies during merges, but financial queries must still use FINAL or group by
-- event_id with argMax(..., version). An ordinary SELECT is not a billing-safe deduplication step.

CREATE DATABASE IF NOT EXISTS sproutos;

create table if not exists sproutos.usage_event_raw (
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
  version UInt64,
  constraint usage_event_id_is_sha256 check match(event_id, '^[0-9a-f]{64}$')
)
engine = ReplacingMergeTree(version)
partition by toYYYYMM(occurred_at)
order by event_id
settings index_granularity = 8192;

create table if not exists sproutos.usage_event_queue (
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
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'usage-events',
  kafka_group_name = 'clickhouse-usage-event-v1',
  kafka_format = 'JSONEachRow',
  kafka_max_block_size = 65536;

create materialized view if not exists sproutos.usage_event_mv to sproutos.usage_event_raw as
select event_id, organization_id, project_id, resource_type, resource_id, dimension, quantity,
       occurred_at, window_start, window_end, node_id, pod_uid, source, external_id,
       charged_externally, attributes, ingested_at, version
from sproutos.usage_event_queue;
