#!/usr/bin/env bash
set -euo pipefail

# The immutable ECS migration and the legacy EC2 release are two launch paths for the same
# production API and worker. ClickHouse does not create a missing database on connection, so a
# typo here survives tofu validation and fails only after the one-off migration task starts.
ecs_file="tofu/ecs.tf"
web_task_file="deploy/ecs/web-task-definition.json"
migration_task_file="deploy/ecs/web-migrate-task-definition.json"
legacy_file="tofu/user-data.sh.tftpl"

ecs_database="$(sed -n 's/^  ecs_clickhouse_database = "\([^"]*\)"$/\1/p' "$ecs_file")"
legacy_database="$(sed -n 's/^CLICKHOUSE_DATABASE=\([^[:space:]]*\)$/\1/p' "$legacy_file")"

[ -n "$ecs_database" ]
[ -n "$legacy_database" ]
[ "$ecs_database" = "$legacy_database" ]

web_references="$(jq '[.containerDefinitions[].environment[]? | select(.name == "CLICKHOUSE_DATABASE" and .value == "sproutos")] | length' "$web_task_file")"
migration_references="$(jq '[.containerDefinitions[].environment[]? | select(.name == "CLICKHOUSE_DATABASE" and .value == "sproutos")] | length' "$migration_task_file")"
acme_references="$(sed -n '/^resource "aws_ecs_task_definition" "acme_worker" {$/,/^}$/p' "$ecs_file" \
  | grep -c 'name = "CLICKHOUSE_DATABASE", value = local.ecs_clickhouse_database')"
if [ "$web_references" -ne 2 ] || [ "$migration_references" -ne 1 ] || [ "$acme_references" -ne 1 ]; then
  echo "expected API + platform worker (2), migration (1), and ACME worker (1) to share the production ClickHouse database; found $web_references + $migration_references + $acme_references" >&2
  exit 1
fi

if grep -q 'name = "CLICKHOUSE_DATABASE", value = "' "$ecs_file" \
  || jq -e --arg database "$ecs_database" \
    '[.containerDefinitions[].environment[]? | select(.name == "CLICKHOUSE_DATABASE" and .value != $database)] | length > 0' \
    "$web_task_file" "$migration_task_file" >/dev/null; then
  echo "an ECS container bypasses the shared production ClickHouse database contract" >&2
  exit 1
fi

echo "ECS API, platform worker, migration, and ACME worker use the legacy production ClickHouse database: $ecs_database"
