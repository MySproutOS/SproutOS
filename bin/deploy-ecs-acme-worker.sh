#!/usr/bin/env bash
# Publish the IAM-isolated ACME worker from the same immutable image as the control plane.
set -euo pipefail

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"
if ! [[ "$IMAGE" =~ :[0-9a-f]{12}$ ]]; then
  echo "IMAGE must end in a 12-character lowercase Git SHA tag, got: $IMAGE" >&2
  exit 2
fi

CLUSTER="${ECS_CLUSTER:-$NAME_PREFIX}"
SERVICE="${ECS_ACME_WORKER_SERVICE:-$NAME_PREFIX-acme-worker}"
DEPLOYMENT_CONFIGURATION="maximumPercent=150,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}"
PLACEMENT_STRATEGY=(
  "type=spread,field=attribute:ecs.availability-zone"
  "type=binpack,field=memory"
)
PLACEMENT_CONSTRAINT="type=distinctInstance"

service_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
status=$(jq -r '.services[0].status // empty' <<<"$service_json")
missing=$(jq -r '[.failures[]? | select(.reason == "MISSING")] | length' <<<"$service_json")
if [ "$status" != "ACTIVE" ]; then
  if [ "$missing" = "1" ]; then
    echo "ACME worker service is not provisioned yet; skipping its backward-compatible release"
    exit 0
  fi
  echo "ECS service $CLUSTER/$SERVICE is not ACTIVE" >&2
  exit 1
fi

current_task=$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")
desired=$(jq -r '.services[0].desiredCount // empty' <<<"$service_json")
if [ -z "$current_task" ] || ! [[ "$desired" =~ ^[0-9]+$ ]]; then
  echo "ACME worker service has an invalid task definition or desired count" >&2
  exit 1
fi
if [ "$desired" != "0" ] && [ "$desired" != "2" ]; then
  echo "ACME worker desired count must be 0 while gated or 2 while enabled, got: $desired" >&2
  exit 1
fi
base_task="${ECS_BASE_ACME_TASK_DEFINITION:-$current_task}"
base_json=$(aws ecs describe-task-definition --task-definition "$base_task" --output json)
family=$(jq -r '.taskDefinition.family // empty' <<<"$base_json")
resolved_base=$(jq -r '.taskDefinition.taskDefinitionArn // empty' <<<"$base_json")
status=$(jq -r '.taskDefinition.status // empty' <<<"$base_json")
current_family="${current_task##*/}"
current_family="${current_family%:*}"
if [ -z "$family" ] || [ "$family" != "$current_family" ] || [ "$status" != "ACTIVE" ]; then
  echo "ACME base task definition is not active in service family $current_family" >&2
  exit 1
fi
if [ -n "${ECS_BASE_ACME_TASK_DEFINITION:-}" ] && \
   [ "$resolved_base" != "$ECS_BASE_ACME_TASK_DEFINITION" ]; then
  echo "ECS_BASE_ACME_TASK_DEFINITION must be an exact task-definition ARN including revision" >&2
  exit 1
fi

task_file=$(mktemp)
cleanup() { unlink "$task_file" 2>/dev/null || true; }
trap cleanup EXIT
jq --arg image "$IMAGE" '
  .taskDefinition
  | {
      family, taskRoleArn, executionRoleArn, networkMode,
      containerDefinitions: [.containerDefinitions[] | .image = $image],
      volumes, placementConstraints, requiresCompatibilities, cpu, memory,
      ipcMode, pidMode, proxyConfiguration, inferenceAccelerators,
      ephemeralStorage, runtimePlatform, enableFaultInjection
    }
  | with_entries(select(.value != null and .value != []))
' <<<"$base_json" > "$task_file"

new_task=$(aws ecs register-task-definition \
  --cli-input-json "file://$task_file" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
if [ -z "$new_task" ] || [ "$new_task" = "None" ]; then
  echo "register-task-definition returned no ACME worker task ARN" >&2
  exit 1
fi

rollback() {
  echo "rolling $CLUSTER/$SERVICE back to $current_task" >&2
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$current_task" --desired-count "$desired" \
    --deployment-configuration "$DEPLOYMENT_CONFIGURATION" \
    --availability-zone-rebalancing ENABLED \
    --placement-strategy "${PLACEMENT_STRATEGY[@]}" \
    --placement-constraints "$PLACEMENT_CONSTRAINT" \
    --force-new-deployment >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
}

echo "updating $CLUSTER/$SERVICE to $new_task"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$new_task" --desired-count "$desired" \
  --deployment-configuration "$DEPLOYMENT_CONFIGURATION" \
  --availability-zone-rebalancing ENABLED \
  --placement-strategy "${PLACEMENT_STRATEGY[@]}" \
  --placement-constraints "$PLACEMENT_CONSTRAINT" \
  --force-new-deployment >/dev/null
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"; then
  echo "ACME worker release did not stabilize within the bounded ECS waiter" >&2
  rollback || true
  exit 1
fi

settled=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
settled_task=$(jq -r '.services[0].taskDefinition // empty' <<<"$settled")
settled_running=$(jq -r '.services[0].runningCount // -1' <<<"$settled")
if [ "$settled_task" != "$new_task" ] || [ "$settled_running" != "$desired" ]; then
  echo "ACME worker waiter returned before the requested release settled" >&2
  if [ "$settled_task" != "$current_task" ] || [ "$settled_running" != "$desired" ]; then
    rollback || true
  fi
  exit 1
fi
echo "ECS ACME worker release is stable on $new_task"
