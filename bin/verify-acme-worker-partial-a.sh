#!/usr/bin/env bash
# Prove the single incomplete phase-A state that the repair wrapper is allowed to recover.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: verify-acme-worker-partial-a.sh <saved.tfplan>" >&2
  exit 2
fi
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
source "$HERE/lib/acme-rollout-policy.sh"
CLUSTER="${ECS_CLUSTER:-$NAME_PREFIX}"
WEB_SERVICE="${ECS_SERVICE:-$NAME_PREFIX-web}"
ACME_SERVICE="${ECS_ACME_WORKER_SERVICE:-$NAME_PREFIX-acme-worker}"

state=$(tofu -chdir="$TOFU_DIR" output -json acme_worker_rollout_state)
if ! jq -e '
  .capacity_enabled == false and
  .handler_ownership_enabled == false and
  .fallback_iam_enabled == true
' <<<"$state" >/dev/null; then
  echo "OpenTofu state is not phase A" >&2
  exit 1
fi

plan_json=$(tofu -chdir="$TOFU_DIR" show -json "$1")
launch_before=$(jq -c '
  [.resource_changes[] | select(.address == "aws_launch_template.ecs")][0].change.before
  | {id, name, latest_version, default_version}
' <<<"$plan_json")
if ! jq -e --arg name "$NAME_PREFIX" '
  (.id | type) == "string" and (.id | length) > 0 and
  (.name | type) == "string" and (.name | startswith($name + "-ecs-")) and
  (.latest_version | type) == "number" and
  (.default_version | type) == "number"
' <<<"$launch_before" >/dev/null; then
  echo "partial-A plan has no concrete ECS launch-template before state" >&2
  exit 1
fi
launch_id=$(jq -r '.id' <<<"$launch_before")
live_launch=$(aws ec2 describe-launch-templates --launch-template-ids "$launch_id" --output json)
if ! jq -e --argjson expected "$launch_before" '
  (.LaunchTemplates | length) == 1 and
  .LaunchTemplates[0].LaunchTemplateId == $expected.id and
  .LaunchTemplates[0].LaunchTemplateName == $expected.name and
  .LaunchTemplates[0].LatestVersionNumber == $expected.latest_version and
  .LaunchTemplates[0].DefaultVersionNumber == $expected.default_version
' <<<"$live_launch" >/dev/null; then
  echo "live ECS launch-template identity or version drifted from the reviewed repair plan" >&2
  exit 1
fi

services=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$WEB_SERVICE" "$ACME_SERVICE" --output json)
if ! jq -e --arg web "$WEB_SERVICE" --arg acme "$ACME_SERVICE" '
  ([.services[] | select(.serviceName == $web)] | length) == 1 and
  ([.services[] | select(.serviceName == $acme)] | length) == 0 and
  (.failures | length) == 1 and
  (.failures[0].reason == "MISSING") and
  ((.failures[0].arn == $acme) or (.failures[0].arn | endswith("/" + $acme)))
' <<<"$services" >/dev/null; then
  echo "partial-A repair requires only the isolated ECS service to be missing" >&2
  exit 1
fi

web=$(jq -c --arg web "$WEB_SERVICE" '.services[] | select(.serviceName == $web)' <<<"$services")
if ! jq -e '
  .taskDefinition as $task
  | .status == "ACTIVE" and
    .desiredCount == 2 and .runningCount == 2 and .pendingCount == 0 and
    ([.deployments[] | select(
      .status == "PRIMARY" and .taskDefinition == $task and
      .desiredCount == 2 and .runningCount == 2 and .pendingCount == 0 and
      .rolloutState == "COMPLETED"
    )] | length) == 1 and
    (.deployments | length) == 1
' <<<"$web" >/dev/null; then
  echo "phase-A web service is not exactly stable at two tasks" >&2
  exit 1
fi

web_task=$(jq -r '.taskDefinition' <<<"$web")
definition=$(aws ecs describe-task-definition --task-definition "$web_task" --output json)
web_base=$(tofu -chdir="$TOFU_DIR" output -raw ecs_web_task_definition_arn)
base_definition=$(aws ecs describe-task-definition --task-definition "$web_base" --output json)
expected_containers=$(jq -c '.taskDefinition.containerDefinitions' <<<"$base_definition")
if ! jq -e '
  ([.[] | select(.name == "worker")] | length) == 1 and
  ([.[] | select(.name == "api")] | length) == 1 and
  ([.[] | select(.name == "worker").environment[]
    | select(.name == "ACME_HANDLER_OWNERSHIP_ENABLED" and .value == "0")] | length) == 1 and
  ([.[] | select(.name == "worker").environment[]
    | select(.name == "ANDROID_ARTIFACT_BUCKET" and (.value | type) == "string" and (.value | length) > 0)] | length) == 1 and
  ([.[] | select(.name == "api").environment[]
    | select(.name == "ANDROID_ARTIFACT_BUCKET" and (.value | type) == "string" and (.value | length) > 0)] | length) == 1 and
  ([.[] | select(.name == "api" or .name == "worker").environment[]
    | select(.name == "ANDROID_ARTIFACT_BUCKET").value] | unique | length) == 1
' <<<"$expected_containers" >/dev/null; then
  echo "reviewed OpenTofu web task lacks the exact ownership or Android bucket recovery entries" >&2
  exit 1
fi
if ! jq -e '
  ([.taskDefinition.containerDefinitions[] | select(.name == "api").environment[]
    | select(.name == "ANDROID_ARTIFACT_BUCKET")] | length) == 0 and
  ([.taskDefinition.containerDefinitions[] | select(.name == "worker").environment[]
    | select(.name == "ANDROID_ARTIFACT_BUCKET")] | length) == 0
' <<<"$definition" >/dev/null; then
  echo "partial-A repair only accepts the diagnosed missing Android bucket entries" >&2
  exit 1
fi
expected_contract=$(jq -Sc --arg image "$IMAGE" '
  .taskDefinition
  | {
      family, taskRoleArn, executionRoleArn, networkMode,
      containerDefinitions: [.containerDefinitions[] | .image = $image],
      volumes, placementConstraints, requiresCompatibilities, cpu, memory,
      ipcMode, pidMode, proxyConfiguration, inferenceAccelerators,
      ephemeralStorage, runtimePlatform, enableFaultInjection
    }
  | with_entries(select(.value != null and .value != []))
' <<<"$base_definition")
# The only compatibility normalizations insert the three diagnosed missing entries at their exact
# reviewed indices. Every other task field, container, environment, secret, role and resource must
# already compare byte-for-byte after canonical JSON object ordering.
live_contract=$(jq -Sc --argjson expected_containers "$expected_containers" '
  def insert_reviewed($container; $entry):
    .containerDefinitions |= map(
      if .name == $container and
        ([.environment[] | select(.name == $entry)] | length) == 0
      then ([$expected_containers[] | select(.name == $container)][0].environment) as $expected_environment
        | ($expected_environment | map(.name) | index($entry)) as $index
        | .environment = (
            .environment[0:$index] +
            [$expected_environment[$index]] +
            .environment[$index:]
          )
      else . end
    );
  .taskDefinition
  | insert_reviewed("worker"; "ACME_HANDLER_OWNERSHIP_ENABLED")
  | insert_reviewed("api"; "ANDROID_ARTIFACT_BUCKET")
  | insert_reviewed("worker"; "ANDROID_ARTIFACT_BUCKET")
  | {
      family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
      volumes, placementConstraints, requiresCompatibilities, cpu, memory,
      ipcMode, pidMode, proxyConfiguration, inferenceAccelerators,
      ephemeralStorage, runtimePlatform, enableFaultInjection
    }
  | with_entries(select(.value != null and .value != []))
' <<<"$definition")
if [ "$live_contract" != "$expected_contract" ] ||
  ! jq -e --arg family "$NAME_PREFIX-web" --arg image "$IMAGE" '
    .family == $family and
    ([.containerDefinitions[].image] | unique) == [$image] and
    ([.containerDefinitions[] | select(.name == "worker")] | length) == 1 and
    (.containerDefinitions[] | select(.name == "worker")
      | ([.environment[] | select(.name == "ACME_JOBS_ENABLED" and .value == "0")] | length) == 1 and
        ([.environment[] | select(.name == "ACME_HANDLER_OWNERSHIP_ENABLED" and .value == "0")] | length) == 1
    )
  ' <<<"$live_contract" >/dev/null; then
  echo "live web task differs beyond the three exact partial-A compatibility entries" >&2
  exit 1
fi

running=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$WEB_SERVICE" \
  --desired-status RUNNING --output json)
if [ "$(jq -r '.taskArns | length' <<<"$running")" != 2 ]; then
  echo "phase-A web service does not have exactly two running task ARNs" >&2
  exit 1
fi
task_arns=()
while IFS= read -r task_arn; do
  task_arns+=("$task_arn")
done < <(jq -r '.taskArns[]' <<<"$running")
tasks=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${task_arns[@]}" --output json)
if ! jq -e --arg task "$web_task" '
  (.failures | length) == 0 and (.tasks | length) == 2 and
  all(.tasks[]; .taskDefinitionArn == $task and .lastStatus == "RUNNING" and .desiredStatus == "RUNNING")
' <<<"$tasks" >/dev/null; then
  echo "phase-A web tasks are not all running the serving revision" >&2
  exit 1
fi

# ECS rejects a service filter for a missing service. Enumerate both live scheduler states at the
# cluster boundary, then reject either the service group or a detached task in the isolated family.
cluster_task_arns=()
for desired_status in RUNNING PENDING; do
  cluster_tasks=$(aws ecs list-tasks --cluster "$CLUSTER" --desired-status "$desired_status" --output json)
  if ! jq -e '(.nextToken // null) == null' <<<"$cluster_tasks" >/dev/null; then
    echo "could not exhaustively enumerate cluster $desired_status tasks" >&2
    exit 1
  fi
  while IFS= read -r task_arn; do
    cluster_task_arns+=("$task_arn")
  done < <(jq -r '.taskArns[]' <<<"$cluster_tasks")
done
if [ "${#cluster_task_arns[@]}" -gt 0 ]; then
  cluster_tasks=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${cluster_task_arns[@]}" --output json)
  if ! jq -e --arg service "service:$ACME_SERVICE" --arg family "$NAME_PREFIX-acme-worker" '
    (.failures | length) == 0 and
    all(.tasks[];
      .group != $service and
      (.taskDefinitionArn | contains(":task-definition/" + $family + ":") | not)
    )
  ' <<<"$cluster_tasks" >/dev/null; then
    echo "missing isolated service still has running, pending, or detached ACME tasks" >&2
    exit 1
  fi
fi

task_role=$(jq -r '.taskDefinition.taskRoleArn' <<<"$definition")
if [ -z "$task_role" ] || [ "$task_role" = null ]; then
  echo "live web task has no task role" >&2
  exit 1
fi
acme_policy=$(tofu -chdir="$TOFU_DIR" output -raw acme_worker_policy_arn)
attached=$(aws iam list-attached-role-policies --role-name "${task_role##*/}" --output json)
if ! jq -e --arg policy "$acme_policy" '
  ([.AttachedPolicies[]? | select(.PolicyArn == $policy)] | length) == 1
' <<<"$attached" >/dev/null; then
  echo "phase-A web task is missing its fallback ACME IAM attachment" >&2
  exit 1
fi

verify_acme_application_policy

echo "live state is the repairable partial phase A: web owns ACME, fallback IAM is attached, and isolated service is absent"
