#!/usr/bin/env bash
set -euo pipefail

# The immutable ECS migration and the legacy EC2 release are two launch paths for the same
# production API and worker. ClickHouse does not create a missing database on connection, so a
# typo here survives tofu validation and fails only after the one-off migration task starts.
ecs_file="tofu/ecs.tf"
legacy_file="tofu/user-data.sh.tftpl"

ecs_database="$(sed -n 's/^  ecs_clickhouse_database = "\([^"]*\)"$/\1/p' "$ecs_file")"
legacy_database="$(sed -n 's/^CLICKHOUSE_DATABASE=\([^[:space:]]*\)$/\1/p' "$legacy_file")"

[ -n "$ecs_database" ]
[ -n "$legacy_database" ]
[ "$ecs_database" = "$legacy_database" ]

reference_count="$(grep -c 'name = "CLICKHOUSE_DATABASE", value = local.ecs_clickhouse_database' "$ecs_file")"
if [ "$reference_count" -ne 2 ]; then
  echo "expected API and worker to share local.ecs_clickhouse_database; found $reference_count references" >&2
  exit 1
fi

if grep -q 'name = "CLICKHOUSE_DATABASE", value = "' "$ecs_file"; then
  echo "an ECS container bypasses the shared production ClickHouse database contract" >&2
  exit 1
fi

echo "ECS API and worker use the legacy production ClickHouse database: $ecs_database"
