#!/usr/bin/env bash
# Move the exact task contracts registered by the last OpenTofu apply into both ECS services.
# This is configuration handoff only: it deliberately never passes --cutover.
set -euo pipefail

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[A-D]$ ]]; then
  echo "usage: handoff-ecs-task-definitions.sh <A|B|C|D>" >&2
  exit 2
fi
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
DEPLOY_SCRIPT="${ECS_DEPLOY_SCRIPT:-$HERE/deploy-ecs-web.sh}"
VERIFY_SCRIPT="${ACME_ROLLOUT_VERIFY_SCRIPT:-$HERE/verify-acme-worker-rollout.sh}"
EXPECTED_PHASE=$1

web_task_arn=$(tofu -chdir="$TOFU_DIR" output -raw ecs_web_task_definition_arn)
acme_task_arn=$(tofu -chdir="$TOFU_DIR" output -raw ecs_acme_worker_task_definition_arn)
rollout_state=$(tofu -chdir="$TOFU_DIR" output -json acme_worker_rollout_state)

capacity_enabled=$(jq -r '.capacity_enabled' <<<"$rollout_state")
handler_ownership_enabled=$(jq -r '.handler_ownership_enabled' <<<"$rollout_state")
fallback_iam_enabled=$(jq -r '.fallback_iam_enabled' <<<"$rollout_state")
for value in "$capacity_enabled" "$handler_ownership_enabled" "$fallback_iam_enabled"; do
  if [ "$value" != "true" ] && [ "$value" != "false" ]; then
    echo "acme_worker_rollout_state must contain boolean rollout gates" >&2
    exit 1
  fi
done
if [ "$handler_ownership_enabled" = "true" ] && [ "$capacity_enabled" != "true" ]; then
  echo "refusing zero-owner handoff: isolated handler ownership has no worker capacity" >&2
  exit 1
fi
if [ "$handler_ownership_enabled" = "false" ] && [ "$fallback_iam_enabled" != "true" ]; then
  echo "refusing no-IAM handoff: platform fallback handlers lack privileged IAM" >&2
  exit 1
fi
case "$EXPECTED_PHASE" in
  A) expected_state='false false true' ;;
  B) expected_state='true false true' ;;
  C) expected_state='true true true' ;;
  D) expected_state='true true false' ;;
esac
if [ "$capacity_enabled $handler_ownership_enabled $fallback_iam_enabled" != "$expected_state" ]; then
  echo "OpenTofu rollout state does not match requested phase $EXPECTED_PHASE" >&2
  exit 1
fi

valid_task_arn() {
  local arn=$1 family=$2 revision
  [[ "$arn" == arn:aws:ecs:*:*:task-definition/"$family":* ]] || return 1
  revision=${arn##*:}
  [[ "$revision" =~ ^[1-9][0-9]*$ ]]
}

if ! valid_task_arn "$web_task_arn" "$NAME_PREFIX-web"; then
  echo "ecs_web_task_definition_arn is not an exact $NAME_PREFIX-web task revision" >&2
  exit 1
fi
if ! valid_task_arn "$acme_task_arn" "$NAME_PREFIX-acme-worker"; then
  echo "ecs_acme_worker_task_definition_arn is not an exact $NAME_PREFIX-acme-worker task revision" >&2
  exit 1
fi

ECS_BASE_TASK_DEFINITION="$web_task_arn" \
  ECS_BASE_ACME_TASK_DEFINITION="$acme_task_arn" \
  "$DEPLOY_SCRIPT"

TOFU_DIR="$TOFU_DIR" "$VERIFY_SCRIPT" "$EXPECTED_PHASE"
