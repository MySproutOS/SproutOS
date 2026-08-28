#!/usr/bin/env bash
# Static workflow invariants. Runtime AWS behavior belongs to deploy-ecs-web.test.sh; this catches
# a future workflow edit that quietly bypasses the tested script or re-enables the legacy website.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW="$ROOT/.github/workflows/deploy.yml"

grep -q "vars.ECS_WEB_ENABLED == 'true'" "$WORKFLOW"
grep -q 'bin/deploy-ecs-web.sh --cutover' "$WORKFLOW"
grep -q 'IMAGE:.*needs.image.outputs.image.*needs.release.outputs.version' "$WORKFLOW"

# The gate must cover all three legacy phases. Merely adding the ECS job while leaving one of these
# behind can revive EC2 workers or make an old image run the new migration.
[ "$(grep -c 'ECS_WEB_ENABLED.*vars.ECS_WEB_ENABLED' "$WORKFLOW")" -ge 3 ]
# This is the literal workflow source being counted.
# shellcheck disable=SC2016
[ "$(grep -c 'services="${services//website/}"' "$WORKFLOW")" -eq 2 ]
grep -q 'website migrations run from the immutable ECS image' "$WORKFLOW"

# The ECS deploy is part of cutover's dependency graph, so router traffic cannot move after a
# failed website deployment in a combined release.
grep -q 'needs: \[fill, migrate, image, ecs_web\]' "$WORKFLOW"
grep -q "needs.ecs_web.result == 'success'" "$WORKFLOW"
grep -q "needs.ecs_web.result == 'skipped'" "$WORKFLOW"

echo "deploy workflow tests passed"
