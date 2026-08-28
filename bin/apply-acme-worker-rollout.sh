#!/usr/bin/env bash
# Apply one reviewed adjacent phase, hand off exact task contracts, and prove the live result.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: apply-acme-worker-rollout.sh <saved.tfplan>" >&2
  exit 2
fi
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
case "$1" in
  /*) PLAN=$1 ;;
  *) PLAN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" ;;
esac
umask 077
VERIFIED_DIR=$(mktemp -d)
VERIFIED_PLAN="$VERIFIED_DIR/verified.tfplan"
cleanup() {
  unlink "$VERIFIED_PLAN" 2>/dev/null || true
  rmdir "$VERIFIED_DIR" 2>/dev/null || true
}
trap cleanup EXIT
cp "$PLAN" "$VERIFIED_PLAN"
chmod 400 "$VERIFIED_PLAN"
plan_digest() { shasum -a 256 "$VERIFIED_PLAN" | awk '{print $1}'; }
verified_digest=$(plan_digest)

transition=$(TOFU_DIR="$TOFU_DIR" "$HERE/check-acme-worker-rollout-plan.sh" "$VERIFIED_PLAN")
before=${transition%%->*}
after=${transition##*->}

# This proof occurs before the apply. A direct A->D plan cannot pass the saved-plan guard, and a
# stale adjacent plan cannot pass this live/state proof before it has a chance to mutate anything.
if [ "$before" != NONE ]; then
  TOFU_DIR="$TOFU_DIR" "$HERE/verify-acme-worker-rollout.sh" "$before"
else
  TOFU_DIR="$TOFU_DIR" "$HERE/verify-tenant-edge-target-groups-empty.sh" "$VERIFIED_PLAN"
fi

if [ "$(plan_digest)" != "$verified_digest" ]; then
  echo "verified saved-plan bytes changed after review; refusing apply" >&2
  exit 1
fi
tofu -chdir="$TOFU_DIR" apply "$VERIFIED_PLAN"

case "$transition" in
  "NONE->A"|"A->B"|"B->C"|"C->B"|"B->A")
    TOFU_DIR="$TOFU_DIR" "$HERE/handoff-ecs-task-definitions.sh" "$after"
    ;;
  "C->D"|"D->C")
    # IAM-only phases deliberately do not manufacture new ECS revisions.
    TOFU_DIR="$TOFU_DIR" "$HERE/verify-acme-worker-rollout.sh" "$after"
    ;;
esac

echo "ACME rollout completed and proved $transition"
