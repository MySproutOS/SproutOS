#!/usr/bin/env bash
#
# Publish one immutable website/API/worker image through ECS.
#
# The service task and the migration task are deliberately separate. The service task owns fixed
# host ports 8080 and 3001, so starting another copy merely to run a command can never be scheduled
# on the same host. The migration definition contains only the API container's runtime contract,
# with no ports, and runs to completion before the service sees the new task definition.
#
# Usage:
#   IMAGE=ghcr.io/mysproutos/sproutos-web:<git-sha> \
#   NAME_PREFIX=sproutos bin/deploy-ecs-web.sh [--cutover]
#
# `ECS_BASE_TASK_DEFINITION` may be an exact task-definition ARN registered by OpenTofu. This is
# the handoff for infrastructure-only container contract changes: the service intentionally ignores
# task-definition drift, so the deploy must derive its migration and service revisions from the
# newly registered revision rather than the revision that is still serving traffic.
#
# `--cutover` is for a push-to-main release (or an explicitly approved manual cutover). It pins the
# website and API rules to ECS's permanent green target groups. Re-running it is idempotent; unlike
# the legacy blue/green command without `--to`, it never tries to send ECS traffic back to blue.
set -euo pipefail

CUTOVER=""
case "${1:-}" in
  "") ;;
  --cutover) CUTOVER=1 ;;
  *) echo "usage: deploy-ecs-web.sh [--cutover]" >&2; exit 2 ;;
esac

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

if ! [[ "$IMAGE" =~ :[0-9a-f]{12}$ ]]; then
  echo "IMAGE must end in a 12-character lowercase Git SHA tag, got: $IMAGE" >&2
  exit 2
fi

CLUSTER="${ECS_CLUSTER:-$NAME_PREFIX}"
SERVICE="${ECS_SERVICE:-$NAME_PREFIX-web}"
DESIRED="${ECS_WEB_DESIRED_COUNT:-2}"
if [ "$DESIRED" != "2" ]; then
  echo "ECS_WEB_DESIRED_COUNT must be 2; the service and its one-host rolling reserve are designed for two steady replicas" >&2
  exit 2
fi

# These values are repeated on update-service deliberately. OpenTofu is the durable declaration,
# but deploys do not run `tofu apply`; carrying the strategy on the release command prevents an old
# live service configuration from dropping below two healthy tasks before a replacement is ready.
# With fixed host ports, ECS asks the managed capacity provider for the ASG's one spare instance;
# 150% permits exactly one replacement task, so the two replicas roll sequentially.
# The AWS services-stable waiter is bounded (40 attempts at 15 seconds), as is the rollback waiter.
DEPLOYMENT_CONFIGURATION="maximumPercent=150,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}"
PLACEMENT_STRATEGY=(
  "type=spread,field=attribute:ecs.availability-zone"
  "type=spread,field=instanceId"
)
PLACEMENT_CONSTRAINT="type=distinctInstance"

tmp_dir=$(mktemp -d)
cleanup() {
  unlink "$tmp_dir/service-task.json" 2>/dev/null || true
  unlink "$tmp_dir/migration-task.json" 2>/dev/null || true
  rmdir "$tmp_dir" 2>/dev/null || true
}
trap cleanup EXIT

service_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
service_status=$(jq -r '.services[0].status // empty' <<<"$service_json")
if [ "$service_status" != "ACTIVE" ]; then
  echo "ECS service $CLUSTER/$SERVICE is not ACTIVE" >&2
  exit 1
fi

current_task_arn=$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")
capacity_provider=$(jq -r '.services[0].capacityProviderStrategy[0].capacityProvider // empty' <<<"$service_json")
if [ -z "$current_task_arn" ] || [ -z "$capacity_provider" ]; then
  echo "ECS service has no task definition or capacity provider" >&2
  exit 1
fi

base_task_arn="${ECS_BASE_TASK_DEFINITION:-$current_task_arn}"
base_json=$(aws ecs describe-task-definition --task-definition "$base_task_arn" --output json)
base_family=$(jq -r '.taskDefinition.family // empty' <<<"$base_json")
resolved_base_arn=$(jq -r '.taskDefinition.taskDefinitionArn // empty' <<<"$base_json")
base_status=$(jq -r '.taskDefinition.status // empty' <<<"$base_json")
current_family="${current_task_arn##*/}"
current_family="${current_family%:*}"
if [ -z "$base_family" ] || [ "$base_family" != "$current_family" ]; then
  echo "base task definition does not belong to the service family $current_family" >&2
  exit 1
fi
if [ -n "${ECS_BASE_TASK_DEFINITION:-}" ] && [ "$resolved_base_arn" != "$ECS_BASE_TASK_DEFINITION" ]; then
  echo "ECS_BASE_TASK_DEFINITION must be an exact task-definition ARN including its revision" >&2
  exit 1
fi
if [ "$base_status" != "ACTIVE" ]; then
  echo "base task definition is not ACTIVE: $base_task_arn" >&2
  exit 1
fi

# Keep every field the current task definition is allowed to register, but none of AWS's output-
# only revision/status/compatibility fields. Every service container gets the exact immutable tag.
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
' <<<"$base_json" > "$tmp_dir/service-task.json"

service_task_arn=$(aws ecs register-task-definition \
  --cli-input-json "file://$tmp_dir/service-task.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
if [ -z "$service_task_arn" ] || [ "$service_task_arn" = "None" ]; then
  echo "register-task-definition returned no service task ARN" >&2
  exit 1
fi

# Copy the API container because it owns the database and ClickHouse runtime contract. Remove its
# listener port and health check, then replace its command with the ordered, fail-fast deploy path.
jq --arg family "$base_family-migrate" --arg image "$IMAGE" '
  .taskDefinition as $task
  | ($task.containerDefinitions[] | select(.name == "api")) as $api
  | {
      family: $family,
      taskRoleArn: $task.taskRoleArn,
      executionRoleArn: $task.executionRoleArn,
      networkMode: $task.networkMode,
      containerDefinitions: [
        $api
        | .name = "migrate"
        | .image = $image
        | .essential = true
        | .cpu = 128
        | .memoryReservation = 128
        | .command = ["sh", "-c", "node /opt/sproutos/api/migrate.mjs && node /opt/sproutos/api/seed.mjs && node /opt/sproutos/api/clickhouse.mjs"]
        # The migration task needs the API database/provider contract, but it never serves the
        # signer protocol. Do not widen either signer bearer token into this transient process.
        | .secrets = [(.secrets // [])[] | select(
            .name != "APK_SIGNER_TOKEN" and
            .name != "APK_SIGNER_OPERATOR_TOKEN"
          )]
        | del(.portMappings, .healthCheck, .dependsOn, .links, .volumesFrom)
        | if .logConfiguration then
            .logConfiguration.options["awslogs-stream-prefix"] = "migrate"
          else . end
      ],
      volumes: $task.volumes,
      placementConstraints: $task.placementConstraints,
      requiresCompatibilities: $task.requiresCompatibilities,
      ipcMode: $task.ipcMode,
      pidMode: $task.pidMode,
      proxyConfiguration: $task.proxyConfiguration,
      inferenceAccelerators: $task.inferenceAccelerators,
      ephemeralStorage: $task.ephemeralStorage,
      runtimePlatform: $task.runtimePlatform,
      enableFaultInjection: $task.enableFaultInjection
    }
  | with_entries(select(.value != null and .value != []))
' <<<"$base_json" > "$tmp_dir/migration-task.json"

migration_task_definition=$(aws ecs register-task-definition \
  --cli-input-json "file://$tmp_dir/migration-task.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
if [ -z "$migration_task_definition" ] || [ "$migration_task_definition" = "None" ]; then
  echo "register-task-definition returned no migration task ARN" >&2
  exit 1
fi

run_json=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$migration_task_definition" \
  --capacity-provider-strategy "capacityProvider=$capacity_provider,weight=1" \
  --count 1 \
  --started-by "deploy-${GITHUB_RUN_ID:-manual}" \
  --output json)

failures=$(jq -r '.failures | length' <<<"$run_json")
migration_task_arn=$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")
if [ "$failures" != "0" ] || [ -z "$migration_task_arn" ]; then
  echo "ECS refused to start the migration task:" >&2
  jq -c '.failures' <<<"$run_json" >&2
  exit 1
fi

echo "waiting for migration task $migration_task_arn"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$migration_task_arn"
migration_result=$(aws ecs describe-tasks \
  --cluster "$CLUSTER" --tasks "$migration_task_arn" --output json)
migration_exit=$(jq -r '.tasks[0].containers[] | select(.name == "migrate") | .exitCode // empty' <<<"$migration_result")
if [ "$migration_exit" != "0" ]; then
  echo "migration failed before the service was changed (exit=${migration_exit:-unknown})" >&2
  jq -r '.tasks[0] | {stopCode, stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}' \
    <<<"$migration_result" >&2
  exit 1
fi

rollback_service() {
  echo "rolling $CLUSTER/$SERVICE back to $current_task_arn" >&2
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$current_task_arn" \
    --desired-count "$DESIRED" \
    --deployment-configuration "$DEPLOYMENT_CONFIGURATION" \
    --availability-zone-rebalancing ENABLED \
    --placement-strategy "${PLACEMENT_STRATEGY[@]}" \
    --placement-constraints "$PLACEMENT_CONSTRAINT" \
    --force-new-deployment >/dev/null

  if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"; then
    echo "rollback did not stabilize within the bounded ECS waiter" >&2
    return 1
  fi

  rollback_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
  rollback_task=$(jq -r '.services[0].taskDefinition // empty' <<<"$rollback_json")
  rollback_running=$(jq -r '.services[0].runningCount // -1' <<<"$rollback_json")
  if [ "$rollback_task" != "$current_task_arn" ] || [ "$rollback_running" != "$DESIRED" ]; then
    echo "rollback waiter returned without restoring the previous release" >&2
    return 1
  fi
  echo "rollback restored $current_task_arn" >&2
}

echo "migration succeeded; updating $CLUSTER/$SERVICE to $service_task_arn"
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$service_task_arn" \
  --desired-count "$DESIRED" \
  --deployment-configuration "$DEPLOYMENT_CONFIGURATION" \
  --availability-zone-rebalancing ENABLED \
  --placement-strategy "${PLACEMENT_STRATEGY[@]}" \
  --placement-constraints "$PLACEMENT_CONSTRAINT" \
  --force-new-deployment >/dev/null
if ! aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"; then
  echo "release did not stabilize within the bounded ECS waiter" >&2
  rollback_service || true
  exit 1
fi

settled_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
settled_task=$(jq -r '.services[0].taskDefinition // empty' <<<"$settled_json")
settled_running=$(jq -r '.services[0].runningCount // -1' <<<"$settled_json")
if [ "$settled_task" != "$service_task_arn" ] || [ "$settled_running" != "$DESIRED" ]; then
  echo "ECS waiter returned but the requested release did not settle" >&2
  echo "  task:    $settled_task (wanted $service_task_arn)" >&2
  echo "  running: $settled_running (wanted $DESIRED)" >&2
  # A completed circuit-breaker rollback already restored the prior revision. Anything else is an
  # incomplete or unexpected state, so restore the exact revision observed before this deploy.
  if [ "$settled_task" != "$current_task_arn" ] || [ "$settled_running" != "$DESIRED" ]; then
    rollback_service || true
  fi
  exit 1
fi

if [ "$DESIRED" -gt 0 ]; then
  while IFS= read -r target_group; do
    # The backticks belong to the AWS JMESPath expression.
    # shellcheck disable=SC2016
    healthy=$(aws elbv2 describe-target-health --target-group-arn "$target_group" \
      --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)
    if ! [[ "$healthy" =~ ^[0-9]+$ ]] || [ "$healthy" -lt "$DESIRED" ]; then
      echo "target group $target_group has $healthy healthy target(s), wanted $DESIRED" >&2
      rollback_service || true
      exit 1
    fi
  done < <(jq -r '.services[0].loadBalancers[].targetGroupArn' <<<"$settled_json")
fi

if [ -n "$CUTOVER" ]; then
  : "${LISTENER_ARN:?LISTENER_ARN is not set for --cutover}"
  : "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set for --cutover}"
  : "${API_RULE_ARN:?API_RULE_ARN is not set for --cutover}"
  "$(dirname "$0")/cutover.sh" website --to green
fi

echo "ECS website release is stable on $service_task_arn"
