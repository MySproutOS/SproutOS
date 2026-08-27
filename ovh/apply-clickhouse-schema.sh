#!/usr/bin/env bash
# Apply idempotent ClickHouse schema changes to an existing data directory. Entrypoint init scripts
# run only on an empty volume, so relying on a container restart would leave production unchanged.
set -euo pipefail

ROOT=${OVH_ROOT:-/opt/sproutos}
ENV_FILE=${OVH_ENV_FILE:-$ROOT/.env}
[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

docker exec -i sproutos_clickhouse clickhouse-client \
  --user "${CLICKHOUSE_USER:-sproutos}" \
  --password "${CLICKHOUSE_PASSWORD:?set CLICKHOUSE_PASSWORD in $ENV_FILE}" \
  --multiquery < "$ROOT/clickhouse-init/02-usage-events.sql"
