#!/usr/bin/env bash
#
# The topic and the consumer the router's producer test needs.
#
# Without the topic, `UnknownTopicHandling::Error` refuses the produce — deliberately, because
# auto-creation turns a typo in a topic name into a second topic nobody consumes. Without the
# ClickHouse consumer, rows are produced successfully and read back never, which is the exact
# silent failure that test exists to catch.
set -euo pipefail

BROKER="${KAFKA_BROKERS:-localhost:29092}"
CLICKHOUSE="${CLICKHOUSE_URL:-http://localhost:28123}"
USER_NAME="${CLICKHOUSE_USER:-sproutos}"
PASSWORD="${CLICKHOUSE_PASSWORD:-sproutos}"

# The service container has no bin on the host, so the topic is created from a throwaway container
# on the host network.
docker run --rm --network host apache/kafka:4.3.1 \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BROKER" \
  --create --topic runtime-logs --partitions 3 --if-not-exists

query() {
  curl -sSf -u "$USER_NAME:$PASSWORD" -X POST "$CLICKHOUSE" --data-binary "$1" >/dev/null
}

query "create database if not exists observability"

# Kept in step with `lib/typescript/observability/src/schema.ts` by being the same statements. A
# schema that exists in only one of the two is a schema that differs between the machine it was
# tested on and the one it runs on.
query "
create table if not exists observability.runtime_log (
  ts DateTime64(3), project_id UUID, deployment_id UUID, request_id String,
  level LowCardinality(String), message String,
  duration_ms Nullable(Float32), billed_ms Nullable(UInt32), memory_mb Nullable(UInt16),
  init_ms Nullable(Float32), cold_start Nullable(Bool)
) engine = MergeTree partition by toDate(ts) order by (project_id, ts, request_id)"

query "
create table if not exists observability.runtime_log_queue (
  ts DateTime64(3), project_id UUID, deployment_id UUID, request_id String,
  level LowCardinality(String), message String,
  duration_ms Nullable(Float32), billed_ms Nullable(UInt32), memory_mb Nullable(UInt16),
  init_ms Nullable(Float32), cold_start Nullable(Bool)
) engine = Kafka
settings kafka_broker_list = 'localhost:9092', kafka_topic_list = 'runtime-logs',
  kafka_group_name = 'clickhouse-runtime-log', kafka_format = 'JSONEachRow',
  kafka_skip_broken_messages = 100"

query "
create materialized view if not exists observability.runtime_log_mv to observability.runtime_log as
select ts, project_id, deployment_id, request_id, level, message,
       duration_ms, billed_ms, memory_mb, init_ms, cold_start
from observability.runtime_log_queue"

echo "kafka topic and clickhouse consumer ready"
