#!/usr/bin/env bash
# Repair only the known partial phase-A foundation, then hand off and prove full phase A.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: apply-acme-worker-partial-a-repair.sh <saved.tfplan>" >&2
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

transition=$(TOFU_DIR="$TOFU_DIR" "$HERE/check-acme-worker-partial-a-repair-plan.sh" "$VERIFIED_PLAN")
if [ "$transition" != "A->A-partial-repair" ]; then
  echo "partial-A checker returned an unexpected transition" >&2
  exit 1
fi
TOFU_DIR="$TOFU_DIR" "$HERE/verify-acme-worker-partial-a.sh" "$VERIFIED_PLAN"
TOFU_DIR="$TOFU_DIR" "$HERE/verify-tenant-edge-target-groups-empty.sh" "$VERIFIED_PLAN"

if [ "$(plan_digest)" != "$verified_digest" ]; then
  echo "verified saved-plan bytes changed after repair review; refusing apply" >&2
  exit 1
fi
tofu -chdir="$TOFU_DIR" apply "$VERIFIED_PLAN"

# The handoff deploys both exact task contracts and invokes the full phase verifier. Success means
# the exceptional partial state no longer exists; subsequent work uses the ordinary adjacent gate.
TOFU_DIR="$TOFU_DIR" "$HERE/handoff-ecs-task-definitions.sh" A

echo "ACME rollout partial-A repair completed and full phase A was proved"
