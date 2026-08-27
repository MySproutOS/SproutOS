#!/usr/bin/env bash
# Scheduled billing-path assertions. A nonzero exit is retained by systemd, written to a marker,
# and optionally sent to the operations webhook; it is never a green no-op.
set -euo pipefail

ROOT=${OVH_ROOT:-/opt/sproutos}
ENV_FILE=${OVH_ENV_FILE:-$ROOT/.env}
STATE_DIR=${CLICKHOUSE_BACKUP_STATE_DIR:-/var/lib/sproutos/clickhouse-backup}
MAX_AGE_SECONDS=${CLICKHOUSE_BACKUP_MAX_AGE_SECONDS:-108000}
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
install -d -m 0700 "$STATE_DIR"

alert() {
  local message="$1"
  printf '%s\n' "$message" > "$STATE_DIR/health-failure"
  logger -p daemon.err -t sproutos-clickhouse-metering -- "$message" || true
  if [ -n "${OPERATIONS_ALERT_WEBHOOK_URL:-}" ]; then
    local payload
    payload=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$message")
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      --data "$payload" "$OPERATIONS_ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}
fail() { alert "ClickHouse metering health failed on $(hostname): $*"; exit 1; }

[ ! -f "$STATE_DIR/last-failure" ] || fail "the latest scheduled backup attempt failed"
[ -f "$STATE_DIR/last-success" ] || fail "no successful backup is recorded"
IFS=$'\t' read -r completed_epoch backup_name _ < "$STATE_DIR/last-success"
[[ "$completed_epoch" =~ ^[0-9]+$ ]] || fail "the backup success marker is malformed"
age=$(( $(date -u +%s) - completed_epoch ))
[ "$age" -le "$MAX_AGE_SECONDS" ] || fail "latest backup $backup_name is ${age}s old"

CH=(docker exec sproutos_clickhouse clickhouse-client
  --user "${CLICKHOUSE_USER:-sproutos}"
  --password "${CLICKHOUSE_PASSWORD:?set CLICKHOUSE_PASSWORD in $ENV_FILE}")
dead_letters=$("${CH[@]}" --query "select count() from sproutos.usage_event_dead_letter")
[ "$dead_letters" = "0" ] || fail "$dead_letters poison usage message(s) require replay from the DLQ"
# Inspect CREATE TABLE rather than trusting the checked-in SQL; existing ClickHouse volumes do not
# rerun entrypoint init scripts.
queue_ddl=$("${CH[@]}" --format TSVRaw --query "show create table sproutos.usage_event_queue")
case "$queue_ddl" in
  *"kafka_handle_error_mode = 'stream'"*) ;;
  *) fail "usage_event_queue is not routing poison messages to stream error columns" ;;
esac
rm -f "$STATE_DIR/health-failure"
echo "metering healthy: backup=$backup_name age=${age}s dlq=0"
