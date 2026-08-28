#!/usr/bin/env bash
# Move the exact task contracts registered by the last OpenTofu apply into both ECS services.
# This is configuration handoff only: it deliberately never passes --cutover.
set -euo pipefail

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
DEPLOY_SCRIPT="${ECS_DEPLOY_SCRIPT:-$HERE/deploy-ecs-web.sh}"

web_task_arn=$(tofu -chdir="$TOFU_DIR" output -raw ecs_web_task_definition_arn)
acme_task_arn=$(tofu -chdir="$TOFU_DIR" output -raw ecs_acme_worker_task_definition_arn)

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
