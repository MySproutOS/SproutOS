#!/usr/bin/env bash
#
# Create the Kafka topics and the external producer's SCRAM identity and ACLs.
#
# Run after `docker compose up -d`, from `/opt/sproutos`. Idempotent: it is the repair procedure for
# broker drift as well as first-time setup. The internal Docker listener is an ANONYMOUS superuser,
# so these administration commands never send the external credential over a plaintext socket.
set -euo pipefail

ENV_FILE="${OVH_ENV_FILE:-/opt/sproutos/.env}"
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

CONTAINER="${KAFKA_CONTAINER:-sproutos_kafka}"
BROKER="${KAFKA_BOOTSTRAP:-kafka:9092}"
RUNTIME_TOPIC="${KAFKA_RUNTIME_LOG_TOPIC:-runtime-logs}"
RUNTIME_USERNAME="${KAFKA_SASL_USERNAME:?set KAFKA_SASL_USERNAME in $ENV_FILE}"
RUNTIME_PASSWORD="${KAFKA_SASL_PASSWORD:?set KAFKA_SASL_PASSWORD in $ENV_FILE}"
USAGE_TOPIC="${KAFKA_USAGE_EVENT_TOPIC:-usage-events}"
USAGE_USERNAME="${KAFKA_USAGE_EVENT_SASL_USERNAME:?set KAFKA_USAGE_EVENT_SASL_USERNAME in $ENV_FILE}"
USAGE_PASSWORD="${KAFKA_USAGE_EVENT_SASL_PASSWORD:?set KAFKA_USAGE_EVENT_SASL_PASSWORD in $ENV_FILE}"

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$BROKER" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server "$BROKER" --list >/dev/null

configure_producer() {
  local topic="$1" username="$2" password="$3"

  # Kafka stores a salted SCRAM verifier, not this password. Re-running rotates the credential to
  # the value in the host's protected environment file.
  docker exec "$CONTAINER" /opt/kafka/bin/kafka-configs.sh \
    --bootstrap-server "$BROKER" \
    --alter --entity-type users --entity-name "$username" \
    --add-config "SCRAM-SHA-512=[iterations=8192,password=$password]" >/dev/null

  docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$BROKER" \
    --create --topic "$topic" --partitions 3 --if-not-exists

  # The API and router produce and never consume. `Describe` is required for metadata; `Write` is
  # the only data operation granted. Repeating `--add` is harmless: Kafka de-duplicates the ACL.
  docker exec "$CONTAINER" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$BROKER" \
    --add --allow-principal "User:$username" \
    --operation Describe --operation Write --topic "$topic" >/dev/null

  docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server "$BROKER" --describe --topic "$topic"

  docker exec "$CONTAINER" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$BROKER" --list --principal "User:$username"
}

# Separate principals are the boundary. The API may write billable events and not logs; the router
# may write logs and not billing events. Kafka enforces that even if either process is compromised.
configure_producer "$RUNTIME_TOPIC" "$RUNTIME_USERNAME" "$RUNTIME_PASSWORD"
configure_producer "$USAGE_TOPIC" "$USAGE_USERNAME" "$USAGE_PASSWORD"

# The production OVH topology consumes over the private Docker listener and needs no Kafka
# credential. If ClickHouse is moved off-host, its server-side topic configuration switches to
# SASL_SSL and this creates a separate read-only identity. Reusing the API's usage producer would
# turn an API compromise into permission to consume and advance the billing consumer group.
if [ "${CLICKHOUSE_USAGE_KAFKA_SECURITY_PROTOCOL:-plaintext}" = "sasl_ssl" ]; then
  CONSUMER_USERNAME="${CLICKHOUSE_USAGE_KAFKA_SASL_USERNAME:?set CLICKHOUSE_USAGE_KAFKA_SASL_USERNAME in $ENV_FILE}"
  CONSUMER_PASSWORD="${CLICKHOUSE_USAGE_KAFKA_SASL_PASSWORD:?set CLICKHOUSE_USAGE_KAFKA_SASL_PASSWORD in $ENV_FILE}"
  CONSUMER_GROUP="clickhouse-usage-event-v1"

  docker exec "$CONTAINER" /opt/kafka/bin/kafka-configs.sh \
    --bootstrap-server "$BROKER" \
    --alter --entity-type users --entity-name "$CONSUMER_USERNAME" \
    --add-config "SCRAM-SHA-512=[iterations=8192,password=$CONSUMER_PASSWORD]" >/dev/null

  docker exec "$CONTAINER" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$BROKER" \
    --add --allow-principal "User:$CONSUMER_USERNAME" \
    --operation Describe --operation Read --topic "$USAGE_TOPIC" >/dev/null
  docker exec "$CONTAINER" /opt/kafka/bin/kafka-acls.sh \
    --bootstrap-server "$BROKER" \
    --add --allow-principal "User:$CONSUMER_USERNAME" \
    --operation Read --group "$CONSUMER_GROUP" >/dev/null
fi
