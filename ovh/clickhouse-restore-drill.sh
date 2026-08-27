#!/usr/bin/env bash
# Restore the latest (or named) metering backup into an isolated database and verify its embedded
# snapshot manifest. This never overwrites production tables.
set -euo pipefail

ROOT=${OVH_ROOT:-/opt/sproutos}
ENV_FILE=${OVH_ENV_FILE:-$ROOT/.env}
STATE_DIR=${CLICKHOUSE_BACKUP_STATE_DIR:-/var/lib/sproutos/clickhouse-backup}
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

backup_name=${1:-}
if [ -z "$backup_name" ]; then
  [ -f "$STATE_DIR/last-success" ] || { echo "no successful backup marker" >&2; exit 1; }
  IFS=$'\t' read -r _ backup_name _ < "$STATE_DIR/last-success"
fi
[[ "$backup_name" =~ ^usage-[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "invalid backup name: $backup_name" >&2; exit 1;
}

CH=(docker exec sproutos_clickhouse clickhouse-client
  --user "${CLICKHOUSE_USER:-sproutos}"
  --password "${CLICKHOUSE_PASSWORD:?set CLICKHOUSE_PASSWORD in $ENV_FILE}")
DRILL=sproutos_restore_drill

"${CH[@]}" --multiquery --query "drop database if exists $DRILL; create database $DRILL"
cleanup() {
  if [ "${KEEP_RESTORE_DRILL:-0}" != "1" ]; then
    "${CH[@]}" --query "drop database if exists $DRILL" >/dev/null || true
  fi
}
trap cleanup EXIT

for table in usage_event_raw usage_event_dead_letter usage_backup_manifest; do
  "${CH[@]}" --query "restore table sproutos.$table as $DRILL.$table
    from Disk('metering_backups', '$backup_name')"
done

IFS=$'\t' read -r cutoff expected_rows expected_checksum expected_dlq < <("${CH[@]}" \
  --format TSVRaw --query "select toString(cutoff), raw_rows, raw_checksum, dead_letter_rows
    from $DRILL.usage_backup_manifest where backup_name = '$backup_name'
    order by created_at desc limit 1")
[ -n "${cutoff:-}" ] || { echo "backup manifest is missing $backup_name" >&2; exit 1; }
IFS=$'\t' read -r actual_rows actual_checksum < <("${CH[@]}" --format TSVRaw --query "
  select count(), groupBitXor(cityHash64(event_id, toString(version), toString(quantity),
    toString(stored_at))) from $DRILL.usage_event_raw final
  where stored_at <= parseDateTime64BestEffort('$cutoff', 3, 'UTC')")
actual_dlq=$("${CH[@]}" --query "select count() from $DRILL.usage_event_dead_letter
  where failed_at <= parseDateTime64BestEffort('$cutoff', 3, 'UTC')")

[ "$actual_rows" = "$expected_rows" ] || {
  echo "restore row count mismatch: got $actual_rows, expected $expected_rows" >&2; exit 1;
}
[ "$actual_checksum" = "$expected_checksum" ] || {
  echo "restore checksum mismatch: got $actual_checksum, expected $expected_checksum" >&2; exit 1;
}
[ "$actual_dlq" = "$expected_dlq" ] || {
  echo "restore DLQ count mismatch: got $actual_dlq, expected $expected_dlq" >&2; exit 1;
}
echo "restore drill passed: $backup_name rows=$actual_rows checksum=$actual_checksum dlq=$actual_dlq"
