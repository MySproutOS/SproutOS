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
  stored_at DateTime64(3, 'UTC') default now64(3, 'UTC'),
  version UInt64,
  constraint usage_event_id_is_sha256 check match(event_id, '^[0-9a-f]{64}$')
)
engine = ReplacingMergeTree(version)
partition by toYYYYMM(occurred_at)
order by event_id
settings index_granularity = 8192;

alter table sproutos.usage_event_raw add column if not exists stored_at DateTime64(3, 'UTC') default now64(3, 'UTC');

-- Kafka engine settings cannot be ALTERed in ClickHouse 25.8. The table itself stores no rows;
-- offsets live in Kafka under the stable group name. Recreating this transport table is therefore
-- the idempotent upgrade path, while the durable destination remains untouched.
drop view if exists sproutos.usage_event_mv;
drop view if exists sproutos.usage_event_dead_letter_mv;
drop table if exists sproutos.usage_event_queue sync;

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
  kafka_group_name = 'clickhouse-sproutos-usage-event-v1',
  kafka_format = 'JSONEachRow',
  kafka_max_block_size = 65536,
  -- A poison message must not stop every later bill. Stream mode exposes `_error` and
  -- `_raw_message`; the two materialized views route good rows and retain bad rows.
  kafka_handle_error_mode = 'stream';

create table if not exists sproutos.usage_event_dead_letter (
  raw_message String,
  error String,
  kafka_topic LowCardinality(String),
  kafka_partition Int64,
  kafka_offset Int64,
  failed_at DateTime64(3, 'UTC') default now64(3, 'UTC')
)
engine = MergeTree
partition by toYYYYMM(failed_at)
order by (failed_at, kafka_partition, kafka_offset);

create table if not exists sproutos.usage_backup_manifest (
  backup_name String,
  cutoff DateTime64(3, 'UTC'),
  raw_rows UInt64,
  raw_checksum UInt64,
  dead_letter_rows UInt64,
  created_at DateTime64(3, 'UTC') default now64(3, 'UTC')
)
engine = MergeTree
order by (created_at, backup_name);

create materialized view if not exists sproutos.usage_event_mv to sproutos.usage_event_raw as
select event_id, organization_id, project_id, resource_type, resource_id, dimension, quantity,
       occurred_at, window_start, window_end, node_id, pod_uid, source, external_id,
       charged_externally, attributes, ingested_at, now64(3, 'UTC') as stored_at, version
from sproutos.usage_event_queue
where length(_error) = 0;

create materialized view if not exists sproutos.usage_event_dead_letter_mv
to sproutos.usage_event_dead_letter as
select _raw_message as raw_message, _error as error, _topic as kafka_topic,
       toInt64(_partition) as kafka_partition, toInt64(_offset) as kafka_offset,
       now64(3, 'UTC') as failed_at
from sproutos.usage_event_queue
where length(_error) > 0;
