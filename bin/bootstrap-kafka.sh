#!/usr/bin/env bash
#
# Create the two platform event topics.
#
# Separate from the ClickHouse schema, which creates the *consumer*: a `Kafka` engine table pointed
# at a topic that does not exist logs a connection error on a timer and consumes nothing, with no
# hint that the missing thing is the topic. Auto-creation is deliberately off on the producer, so
# a typo in the topic name is an error rather than a second topic nobody reads.
set -euo pipefail

BROKER="${KAFKA_BOOTSTRAP:-localhost:9092}"
CONTAINER="${KAFKA_CONTAINER:-sproutos_kafka}"

TOPICS=(
  "${KAFKA_RUNTIME_LOG_TOPIC:-runtime-logs}"
  "${KAFKA_USAGE_EVENT_TOPIC:-usage-events}"
)

for topic in "${TOPICS[@]}"; do
  docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$BROKER" \
    --create --topic "$topic" \
    --partitions 3 --if-not-exists

  # Idempotent and cheap to re-run, like the LocalStack bootstrap next door.
  docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$BROKER" --describe --topic "$topic"
done
