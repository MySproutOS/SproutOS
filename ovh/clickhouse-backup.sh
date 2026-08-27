#!/usr/bin/env bash
# Create a synchronous native ClickHouse backup on the restricted S3 disk. Failure leaves both a
# systemd failure and a marker which the independent health timer/verify script treats as fatal.
set -euo pipefail

ROOT=${OVH_ROOT:-/opt/sproutos}
ENV_FILE=${OVH_ENV_FILE:-$ROOT/.env}
STATE_DIR=${CLICKHOUSE_BACKUP_STATE_DIR:-/var/lib/sproutos/clickhouse-backup}
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

install -d -m 0700 "$STATE_DIR"
exec 9>"$STATE_DIR/backup.lock"
flock -n 9 || { echo "another ClickHouse backup is already running" >&2; exit 1; }

alert() {
  local message="$1"
  logger -p daemon.err -t sproutos-clickhouse-backup -- "$message" || true
  if [ -n "${OPERATIONS_ALERT_WEBHOOK_URL:-}" ]; then
    local payload
    payload=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$message")
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      --data "$payload" "$OPERATIONS_ALERT_WEBHOOK_URL" >/dev/null || true
  fi
}

finished=0
on_exit() {
  local status=$?
  if [ "$finished" -ne 1 ]; then
    local message="ClickHouse metering backup failed on $(hostname) at $(date -u +%FT%TZ) (exit $status)"
    printf '%s\n' "$message" > "$STATE_DIR/last-failure"
    alert "$message"
  fi
  exit "$status"
}
trap on_exit EXIT

CH=(docker exec sproutos_clickhouse clickhouse-client
  --user "${CLICKHOUSE_USER:-sproutos}"
  --password "${CLICKHOUSE_PASSWORD:?set CLICKHOUSE_PASSWORD in $ENV_FILE}")

backup_name="usage-$(date -u +%Y%m%dT%H%M%SZ)"
cutoff=$("${CH[@]}" --query "select toString(now64(3, 'UTC'))")
IFS=$'\t' read -r raw_rows raw_checksum < <("${CH[@]}" --format TSVRaw --query "
  select count(), groupBitXor(cityHash64(event_id, toString(version), toString(quantity),
    toString(stored_at)))
  from sproutos.usage_event_raw final
  where stored_at <= parseDateTime64BestEffort('$cutoff', 3, 'UTC')")
dead_letter_rows=$("${CH[@]}" --query "
  select count() from sproutos.usage_event_dead_letter
  where failed_at <= parseDateTime64BestEffort('$cutoff', 3, 'UTC')")

"${CH[@]}" --query "insert into sproutos.usage_backup_manifest
  (backup_name, cutoff, raw_rows, raw_checksum, dead_letter_rows)
  values ('$backup_name', parseDateTime64BestEffort('$cutoff', 3, 'UTC'),
    $raw_rows, $raw_checksum, $dead_letter_rows)"

# No credential appears in this query: `metering_backups` is the env-backed S3 disk allowlisted in
# config. The command is synchronous; success means ClickHouse finished the remote write.
"${CH[@]}" --query "backup table sproutos.usage_event_raw,
  table sproutos.usage_event_dead_letter,
  table sproutos.usage_backup_manifest
  to Disk('metering_backups', '$backup_name')"

printf '%s\t%s\t%s\n' "$(date -u +%s)" "$backup_name" "$cutoff" \
  > "$STATE_DIR/last-success.tmp"
mv "$STATE_DIR/last-success.tmp" "$STATE_DIR/last-success"
rm -f "$STATE_DIR/last-failure"
finished=1
echo "ClickHouse metering backup completed: $backup_name"
