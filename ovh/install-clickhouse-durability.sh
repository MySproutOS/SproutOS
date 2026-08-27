#!/usr/bin/env bash
# Install the backup and health schedules after the compose stack is running. This deliberately
# performs an initial backup: enabling a timer without proving its command works is not deployment.
set -euo pipefail

ROOT=${OVH_ROOT:-/opt/sproutos}
for script in apply-clickhouse-schema.sh clickhouse-backup.sh clickhouse-metering-health.sh clickhouse-restore-drill.sh; do
  [ -f "$ROOT/$script" ] || { echo "missing $ROOT/$script" >&2; exit 1; }
  chmod 0755 "$ROOT/$script"
done
sudo install -d -m 0700 /var/lib/sproutos/clickhouse-backup

sudo tee /etc/systemd/system/sproutos-clickhouse-backup.service >/dev/null <<UNIT
[Unit]
Description=Back up SproutOS financial ClickHouse tables to restricted S3
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ROOT/clickhouse-backup.sh
TimeoutStartSec=6h
UNIT

sudo tee /etc/systemd/system/sproutos-clickhouse-backup.timer >/dev/null <<'UNIT'
[Unit]
Description=Daily SproutOS ClickHouse metering backup

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
RandomizedDelaySec=15m
Persistent=true
Unit=sproutos-clickhouse-backup.service

[Install]
WantedBy=timers.target
UNIT

sudo tee /etc/systemd/system/sproutos-clickhouse-metering-health.service >/dev/null <<UNIT
[Unit]
Description=Assert SproutOS ClickHouse backup freshness and empty metering DLQ
After=docker.service

[Service]
Type=oneshot
ExecStart=$ROOT/clickhouse-metering-health.sh
TimeoutStartSec=2m
UNIT

sudo tee /etc/systemd/system/sproutos-clickhouse-metering-health.timer >/dev/null <<'UNIT'
[Unit]
Description=Check the SproutOS ClickHouse billing path every five minutes

[Timer]
OnBootSec=5m
OnUnitActiveSec=5m
Persistent=true
Unit=sproutos-clickhouse-metering-health.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
"$ROOT/apply-clickhouse-schema.sh"
sudo systemctl start sproutos-clickhouse-backup.service
sudo systemctl start sproutos-clickhouse-metering-health.service
sudo systemctl enable --now sproutos-clickhouse-backup.timer sproutos-clickhouse-metering-health.timer
echo "ClickHouse durability installed; run $ROOT/clickhouse-restore-drill.sh for the restore proof"
