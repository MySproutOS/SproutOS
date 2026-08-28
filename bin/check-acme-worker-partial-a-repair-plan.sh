#!/usr/bin/env bash
# Accept only the one known repair for a partially applied ACME phase-A foundation.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: check-acme-worker-partial-a-repair-plan.sh <saved.tfplan>" >&2
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
plan_json=$(tofu -chdir="$TOFU_DIR" show -json "$PLAN")
phase_a='{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'

if ! jq -e --argjson phase_a "$phase_a" '
  .output_changes.acme_worker_rollout_state.before == $phase_a and
  .output_changes.acme_worker_rollout_state.after == $phase_a
' <<<"$plan_json" >/dev/null; then
  echo "partial-A repair requires unchanged phase-A rollout outputs" >&2
  exit 1
fi

expected_changes=$(printf '%s\n' \
  'aws_ecs_service.acme_worker|create' \
  'aws_ecs_task_definition.acme_worker|delete,create' \
  'aws_ecs_task_definition.web|delete,create' \
  'aws_launch_template.ecs|update' \
  | LC_ALL=C sort)
actual_changes=$(jq -r '
  .resource_changes[]
  | select(.change.actions != ["no-op"])
  | "\(.address)|\(.change.actions | join(","))"
' <<<"$plan_json" | LC_ALL=C sort)

if [ "$actual_changes" != "$expected_changes" ]; then
  echo "saved plan is not the exact partial-A repair action set" >&2
  echo "expected:" >&2
  printf '%s\n' "$expected_changes" >&2
  echo "actual:" >&2
  printf '%s\n' "$actual_changes" >&2
  exit 1
fi

# The exceptional action allowlist is not enough by itself: pin the contracts those replacements
# will register. In particular, the old serving revision may omit ownership because that runtime
# defaulted an absent flag to false; the replacement must make both false gates explicit.
if ! jq -e --arg image "$IMAGE" --arg name "$NAME_PREFIX" '
  def resource($address):
    [.resource_changes[] | select(.address == $address)][0].change.after;
  (resource("aws_ecs_task_definition.web")) as $web
  | (resource("aws_ecs_task_definition.acme_worker")) as $acme
  | (resource("aws_ecs_service.acme_worker")) as $service
  | (resource("aws_secretsmanager_secret.acme_account_key").id) as $account_key
  | ($web.container_definitions | fromjson) as $web_containers
  | ($acme.container_definitions | fromjson) as $acme_containers
  | $service.name == ($name + "-acme-worker") and
    ($service.cluster | endswith(":cluster/" + $name)) and
    $service.desired_count == 0 and
    $service.capacity_provider_strategy == [{base:null,capacity_provider:($name + "-ec2"),weight:100}] and
    $service.deployment_circuit_breaker == [{enable:true,rollback:true}] and
    $service.deployment_maximum_percent == 150 and
    $service.deployment_minimum_healthy_percent == 100 and
    $service.availability_zone_rebalancing == "ENABLED" and
    $service.scheduling_strategy == "REPLICA" and
    $service.enable_execute_command == false and
    $service.enable_ecs_managed_tags == false and
    ($service.deployment_controller | length) == 0 and
    ($service.network_configuration | length) == 0 and
    ($service.service_registries | length) == 0 and
    $service.ordered_placement_strategy == [
      {field:"attribute:ecs.availability-zone",type:"spread"},
      {field:"memory",type:"binpack"}
    ] and
    ($service.placement_constraints == [{expression:null,type:"distinctInstance"}] or
      $service.placement_constraints == [{expression:"",type:"distinctInstance"}]) and
    ($service.load_balancer | length) == 0 and
    ([.resource_changes[] | select(.address == "aws_ecs_service.acme_worker")][0].change.after_unknown.task_definition == true) and
    $web.family == ($name + "-web") and $web.network_mode == "bridge" and
    ($web.cpu | tonumber) == 896 and ($web.memory | tonumber) == 640 and
    ($web.task_role_arn | endswith(":role/" + $name + "-task")) and
    ($web.execution_role_arn | endswith(":role/" + $name + "-ecs-execution")) and
    ($web_containers | map(.name) | sort) == ["api","website","worker"] and
    ($web_containers | map(.image) | unique) == [$image] and
    ([$web_containers[] | select(.name == "worker")] | length) == 1 and
    ($web_containers[] | select(.name == "worker")
      | ([.environment[] | select(.name == "ACME_JOBS_ENABLED" and .value == "0")] | length) == 1 and
        ([.environment[] | select(.name == "ACME_HANDLER_OWNERSHIP_ENABLED" and .value == "0")] | length) == 1
    ) and
    $acme.family == ($name + "-acme-worker") and $acme.network_mode == "bridge" and
    ($acme.cpu | tonumber) == 128 and ($acme.memory | tonumber) == 256 and
    ($acme.task_role_arn | endswith(":role/" + $name + "-acme-task")) and
    ($acme.execution_role_arn | endswith(":role/" + $name + "-acme-execution")) and
    $acme.task_role_arn != $web.task_role_arn and
    $acme.execution_role_arn != $web.execution_role_arn and
    ($acme_containers | map(.name)) == ["acme-worker"] and
    ($acme_containers | map(.image) | unique) == [$image] and
    ([$acme_containers[] | select(.name == "acme-worker")] | length) == 1 and
    ($acme_containers[] | select(.name == "acme-worker")
      | ([.environment[] | select(.name == "WORKER_PROFILE" and .value == "acme")] | length) == 1 and
        ([.environment[] | select(.name == "ACME_ACCOUNT_KEY_SECRET_ID" and .value == $account_key)] | length) == 1
    )
' <<<"$plan_json" >/dev/null; then
  echo "partial-A repair does not preserve zero isolated capacity or register the exact task contracts" >&2
  exit 1
fi

if ! jq -e --arg name "$NAME_PREFIX" '
  [.resource_changes[] | select(.address == "aws_launch_template.ecs")][0].change as $change
  | ($change.before | {id,name,default_version}) == ($change.after | {id,name,default_version}) and
    ($change.before.id | type) == "string" and
    ($change.before.name | startswith($name + "-ecs-")) and
    ($change.before.latest_version | type) == "number" and
    ($change.before.default_version | type) == "number" and
    $change.after_unknown.latest_version == true
' <<<"$plan_json" >/dev/null; then
  echo "partial-A repair does not preserve the existing ECS launch-template identity and default version" >&2
  exit 1
fi

launch_user_data=$(jq -er '
  [.resource_changes[] | select(.address == "aws_launch_template.ecs")][0].change.after.user_data
  | select(type == "string" and length > 0)
' <<<"$plan_json") || {
  echo "partial-A repair launch template has no concrete user data" >&2
  exit 1
}
umask 077
gzip_file=$(mktemp)
cleanup() { unlink "$gzip_file" 2>/dev/null || true; }
trap cleanup EXIT
if ! printf '%s' "$launch_user_data" | base64 -d >"$gzip_file" 2>/dev/null ||
  ! gzip -t "$gzip_file" 2>/dev/null; then
  echo "partial-A repair launch-template user data is not valid base64-encoded gzip" >&2
  exit 1
fi
gzip_bytes=$(wc -c <"$gzip_file" | tr -d ' ')
if [ "$gzip_bytes" -gt 16384 ]; then
  echo "partial-A repair launch-template user data exceeds EC2's 16384-byte decoded limit ($gzip_bytes)" >&2
  exit 1
fi

echo "A->A-partial-repair"
