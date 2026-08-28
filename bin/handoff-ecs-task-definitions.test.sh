#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
cleanup() {
  find "$TMP" -type f -delete
  rmdir "$TMP/bin" 2>/dev/null || true
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

mkdir "$TMP/bin"
cat >"$TMP/bin/tofu" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${*: -1}" in
  ecs_web_task_definition_arn)
    echo "arn:aws:ecs:us-east-1:111122223333:task-definition/sproutos-web:41"
    ;;
  ecs_acme_worker_task_definition_arn)
    echo "arn:aws:ecs:us-east-1:111122223333:task-definition/sproutos-acme-worker:7"
    ;;
  acme_worker_rollout_state)
    printf '%s\n' "$ROLLOUT_STATE"
    ;;
  *)
    echo "unexpected tofu invocation: $*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$TMP/bin/tofu"

cat >"$TMP/deploy" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${ECS_BASE_TASK_DEFINITION:?}"
: "${ECS_BASE_ACME_TASK_DEFINITION:?}"
echo called >>"$DEPLOY_CALLS"
STUB
chmod +x "$TMP/deploy"

run_handoff() {
  ROLLOUT_STATE=$1 \
    DEPLOY_CALLS="$TMP/deploy-calls" \
    PATH="$TMP/bin:$PATH" \
    NAME_PREFIX=sproutos \
    IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab \
    ECS_DEPLOY_SCRIPT="$TMP/deploy" \
    "$ROOT/bin/handoff-ecs-task-definitions.sh"
}

run_handoff '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
run_handoff '{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
run_handoff '{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":true}'
run_handoff '{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":false}'

if run_handoff '{"capacity_enabled":false,"handler_ownership_enabled":true,"fallback_iam_enabled":true}' \
  >"$TMP/zero-owner.out" 2>&1; then
  echo "handoff accepted isolated ownership without capacity" >&2
  exit 1
fi
grep -q "refusing zero-owner handoff" "$TMP/zero-owner.out"

if run_handoff '{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":false}' \
  >"$TMP/no-iam.out" 2>&1; then
  echo "handoff accepted platform ownership without fallback IAM" >&2
  exit 1
fi
grep -q "refusing no-IAM handoff" "$TMP/no-iam.out"

if run_handoff '{"capacity_enabled":"yes","handler_ownership_enabled":false,"fallback_iam_enabled":true}' \
  >"$TMP/malformed.out" 2>&1; then
  echo "handoff accepted malformed rollout state" >&2
  exit 1
fi
grep -q "must contain boolean rollout gates" "$TMP/malformed.out"

test "$(wc -l <"$TMP/deploy-calls" | tr -d ' ')" = "4"
echo "ACME task-definition handoff rejects every unsafe rollout state"
