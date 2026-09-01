#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rendered=$(mktemp)
cleanup() { unlink "$rendered" 2>/dev/null || true; }
trap cleanup EXIT
TOFU_DIR="$ROOT/tofu" "$ROOT/bin/render-ecs-launch-template-user-data.sh" sproutos >"$rendered"

test "$(wc -c <"$rendered" | tr -d ' ')" = 21839
test "$(shasum -a 256 "$rendered" | awk '{print $1}')" = \
  9890e7851f71411cefa6078953821d6f3d805d9f12be3473090ef1f4fbba627c

echo "ECS launch-template renderer matches the reviewed decoded production bootstrap"
