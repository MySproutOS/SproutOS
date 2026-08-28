#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rendered=$(mktemp)
cleanup() { unlink "$rendered" 2>/dev/null || true; }
trap cleanup EXIT
TOFU_DIR="$ROOT/tofu" "$ROOT/bin/render-ecs-launch-template-user-data.sh" sproutos >"$rendered"

test "$(wc -c <"$rendered" | tr -d ' ')" = 21307
test "$(shasum -a 256 "$rendered" | awk '{print $1}')" = \
  b658950b41c7c6cedbf0b0a86104f0ef3c5390bf6e1d5f1417f121b92d454dcd

echo "ECS launch-template renderer matches the reviewed decoded production bootstrap"
