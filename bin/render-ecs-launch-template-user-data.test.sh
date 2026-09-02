#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rendered=$(mktemp)
cleanup() { unlink "$rendered" 2>/dev/null || true; }
trap cleanup EXIT
TOFU_DIR="$ROOT/tofu" "$ROOT/bin/render-ecs-launch-template-user-data.sh" sproutos >"$rendered"

test "$(wc -c <"$rendered" | tr -d ' ')" = 21839
test "$(shasum -a 256 "$rendered" | awk '{print $1}')" = \
  a4ba09fb3fd93c2e9e13d89001f415cd95629afd788c8d0a7f8e4074444e7836

echo "ECS launch-template renderer matches the reviewed decoded production bootstrap"
