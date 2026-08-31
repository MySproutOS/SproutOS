#!/usr/bin/env bash
# Static workflow invariants. Runtime AWS behavior belongs to deploy-ecs-web.test.sh; this catches
# a future workflow edit that quietly bypasses the tested script or re-enables the legacy website.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW="$ROOT/.github/workflows/deploy.yml"

grep -q "vars.ECS_WEB_ENABLED == 'true'" "$WORKFLOW"
grep -q 'bin/deploy-ecs-web.sh --cutover' "$WORKFLOW"
grep -q 'IMAGE:.*needs.image.outputs.image.*needs.release.outputs.version' "$WORKFLOW"
grep -q 'task-definition: deploy/ecs/web-task-definition.json' "$WORKFLOW"
grep -q 'task-definition: deploy/ecs/web-migrate-task-definition.json' "$WORKFLOW"
[ "$(grep -c 'aws-actions/amazon-ecs-render-task-definition@v1' "$WORKFLOW")" -eq 4 ]
grep -q 'SERVICE_TASK_DEFINITION_FILE:.*render-worker.outputs.task-definition' "$WORKFLOW"
grep -q 'MIGRATION_TASK_DEFINITION_FILE:.*render-migration.outputs.task-definition' "$WORKFLOW"

# The gate must cover all three legacy phases. Merely adding the ECS job while leaving one of these
# behind can revive EC2 workers or make an old image run the new migration.
[ "$(grep -c 'ECS_WEB_ENABLED.*vars.ECS_WEB_ENABLED' "$WORKFLOW")" -ge 3 ]
# This is the literal workflow source being counted.
# shellcheck disable=SC2016
[ "$(grep -c 'services="${services//website/}"' "$WORKFLOW")" -eq 2 ]
grep -q 'website migrations run from the immutable ECS image' "$WORKFLOW"

# One deployment owns production through its delayed acceptance checks. A later push queues, and
# the router fill waits for ECS so the two releases cannot simultaneously consume DB headroom.
grep -q '^  group: deploy$' "$WORKFLOW"
grep -q '^  cancel-in-progress: false$' "$WORKFLOW"
grep -q 'needs: \[release, image, preflight\]' "$WORKFLOW"
grep -q 'needs: \[release, preflight, ecs_web\]' "$WORKFLOW"
grep -q 'https://api.${CONTROL_PLANE_DOMAIN}/ready' "$WORKFLOW"
grep -q 'name: Verify the deployed production system' "$WORKFLOW"

# These checked-in task templates are the deployed website/API/worker contract. Updating only the
# EC2/OpenTofu environment would leave sandbox creation on the previous proxy URL after every ECS
# release, which is the mismatch this assertion is meant to make loud.
for task in \
  "$ROOT/deploy/ecs/web-task-definition.json" \
  "$ROOT/deploy/ecs/web-migrate-task-definition.json"; do
  jq -e '
    [.containerDefinitions[].environment[]?
      | select(.name == "SANDBOX_FORWARD_PROXY_URL")
      | .value] as $values
    | ($values | length) > 0
      and all($values[]; . == "http://egress.sproutos.me:3128")
  ' "$task" >/dev/null
  jq -e '
    all(.containerDefinitions[];
      any(.environment[]?; .name == "DATABASE_POOL_MAX" and .value == "4"))
  ' "$task" >/dev/null
done

# The ECS deploy is part of cutover's dependency graph, so router traffic cannot move after a
# failed website deployment in a combined release.
grep -q 'needs: \[fill, migrate, image, ecs_web\]' "$WORKFLOW"
grep -q "needs.ecs_web.result == 'success'" "$WORKFLOW"
grep -q "needs.ecs_web.result == 'skipped'" "$WORKFLOW"

echo "deploy workflow tests passed"
