#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rendered=$(mktemp)
cleanup() { unlink "$rendered" 2>/dev/null || true; }
trap cleanup EXIT
TOFU_DIR="$ROOT/tofu" "$ROOT/bin/render-ecs-launch-template-user-data.sh" sproutos >"$rendered"

test "$(wc -c <"$rendered" | tr -d ' ')" = 21303
test "$(shasum -a 256 "$rendered" | awk '{print $1}')" = \
  6fe5f81e9cb0b033afc9c347612359cbf965377c970be90840806620ff0c8edf

echo "ECS launch-template renderer matches the reviewed decoded production bootstrap"
