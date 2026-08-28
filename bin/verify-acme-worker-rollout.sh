#!/usr/bin/env bash
# Prove that Terraform state and both live ECS services implement one exact ACME rollout phase.
set -euo pipefail

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[A-D]$ ]]; then
  echo "usage: verify-acme-worker-rollout.sh <A|B|C|D>" >&2
  exit 2
fi
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${IMAGE:?IMAGE is not set}"

PHASE=$1
HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
CLUSTER="${ECS_CLUSTER:-$NAME_PREFIX}"
WEB_SERVICE="${ECS_SERVICE:-$NAME_PREFIX-web}"
ACME_SERVICE="${ECS_ACME_WORKER_SERVICE:-$NAME_PREFIX-acme-worker}"

case "$PHASE" in
  A) capacity=false; ownership=false; fallback=true; acme_count=0 ;;
  B) capacity=true;  ownership=false; fallback=true; acme_count=2 ;;
  C) capacity=true;  ownership=true;  fallback=true; acme_count=2 ;;
  D) capacity=true;  ownership=true;  fallback=false; acme_count=2 ;;
esac
capacity_env=$([ "$capacity" = true ] && printf 1 || printf 0)
ownership_env=$([ "$ownership" = true ] && printf 1 || printf 0)

state=$(tofu -chdir="$TOFU_DIR" output -json acme_worker_rollout_state)
if ! jq -e --argjson capacity "$capacity" --argjson ownership "$ownership" --argjson fallback "$fallback" '
  .capacity_enabled == $capacity and
  .handler_ownership_enabled == $ownership and
  .fallback_iam_enabled == $fallback
' <<<"$state" >/dev/null; then
  echo "OpenTofu state is not rollout phase $PHASE" >&2
  exit 1
fi

web_base=$(tofu -chdir="$TOFU_DIR" output -raw ecs_web_task_definition_arn)
acme_base=$(tofu -chdir="$TOFU_DIR" output -raw ecs_acme_worker_task_definition_arn)
acme_policy=$(tofu -chdir="$TOFU_DIR" output -raw acme_worker_policy_arn)
application_policy=$(tofu -chdir="$TOFU_DIR" output -raw application_policy_arn)
reviewed_policy=$(tofu -chdir="$TOFU_DIR" output -raw application_policy_document)
services=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$WEB_SERVICE" "$ACME_SERVICE" --output json)
if [ "$(jq -r '.failures | length' <<<"$services")" != 0 ]; then
  echo "ECS service lookup failed" >&2
  jq -c '.failures' <<<"$services" >&2
  exit 1
fi

verify_service() {
  local service_name=$1 expected_count=$2 family=$3 base_task=$4 container=$5
  local service live_task live_definition base_definition expected_contract live_contract
  local running_tasks runtime_tasks task_arns=()
  service=$(jq -c --arg name "$service_name" '.services[] | select(.serviceName == $name)' <<<"$services")
  if [ -z "$service" ]; then
    echo "ECS service $service_name is missing" >&2
    exit 1
  fi
  if ! jq -e --argjson count "$expected_count" '
    .taskDefinition as $task
    | .status == "ACTIVE" and
      .desiredCount == $count and .runningCount == $count and .pendingCount == 0 and
      ([.deployments[] | select(
        .status == "PRIMARY" and .taskDefinition == $task and
        .desiredCount == $count and .runningCount == $count and .pendingCount == 0 and
        .rolloutState == "COMPLETED"
      )] | length) == 1 and
      (.deployments | length) == 1
  ' <<<"$service" >/dev/null; then
    echo "ECS service $service_name is not exactly stable at $expected_count tasks" >&2
    exit 1
  fi

  live_task=$(jq -r '.taskDefinition' <<<"$service")
  live_definition=$(aws ecs describe-task-definition --task-definition "$live_task" --output json)
  base_definition=$(aws ecs describe-task-definition --task-definition "$base_task" --output json)
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
  live_contract=$(jq -Sc '
    .taskDefinition
    | {
        family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
        volumes, placementConstraints, requiresCompatibilities, cpu, memory,
        ipcMode, pidMode, proxyConfiguration, inferenceAccelerators,
        ephemeralStorage, runtimePlatform, enableFaultInjection
      }
    | with_entries(select(.value != null and .value != []))
  ' <<<"$live_definition")
  if [ "$live_contract" != "$expected_contract" ] ||
    ! jq -e --arg family "$family" --arg image "$IMAGE" --arg container "$container" '
      .taskDefinition.family == $family and
      ([.taskDefinition.containerDefinitions[].image] | unique) == [$image] and
      ([.taskDefinition.containerDefinitions[] | select(.name == $container)] | length) == 1
    ' <<<"$live_definition" >/dev/null; then
    echo "serving task definition for $service_name is not the exact reviewed contract and image" >&2
    exit 1
  fi

  if [ "$service_name" = "$WEB_SERVICE" ]; then
    if ! jq -e --arg capacity "$capacity_env" --arg ownership "$ownership_env" '
      .taskDefinition.containerDefinitions[] | select(.name == "worker")
      | ([.environment[] | select(.name == "ACME_JOBS_ENABLED" and .value == $capacity)] | length) == 1
        and ([.environment[] | select(.name == "ACME_HANDLER_OWNERSHIP_ENABLED" and .value == $ownership)] | length) == 1
    ' <<<"$live_definition" >/dev/null; then
      echo "serving platform worker environment does not implement phase $PHASE" >&2
      exit 1
    fi
  elif ! jq -e '
    .taskDefinition.containerDefinitions[] | select(.name == "acme-worker")
    | ([.environment[] | select(.name == "WORKER_PROFILE" and .value == "acme")] | length) == 1
  ' <<<"$live_definition" >/dev/null; then
    echo "serving isolated worker does not have WORKER_PROFILE=acme" >&2
    exit 1
  fi

  running_tasks=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$service_name" \
    --desired-status RUNNING --output json)
  if [ "$(jq -r '.taskArns | length' <<<"$running_tasks")" != "$expected_count" ]; then
    echo "ECS service $service_name does not have exactly $expected_count running task ARNs" >&2
    exit 1
  fi
  if [ "$expected_count" -gt 0 ]; then
    while IFS= read -r task_arn; do
      task_arns+=("$task_arn")
    done < <(jq -r '.taskArns[]' <<<"$running_tasks")
    runtime_tasks=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${task_arns[@]}" --output json)
    if ! jq -e --arg task "$live_task" --argjson count "$expected_count" '
      (.failures | length) == 0 and (.tasks | length) == $count and
      all(.tasks[]; .taskDefinitionArn == $task and .lastStatus == "RUNNING" and .desiredStatus == "RUNNING")
    ' <<<"$runtime_tasks" >/dev/null; then
      echo "running tasks for $service_name are not all on its exact serving revision" >&2
      exit 1
    fi
  fi
}

verify_service "$WEB_SERVICE" 2 "$NAME_PREFIX-web" "$web_base" worker
verify_service "$ACME_SERVICE" "$acme_count" "$NAME_PREFIX-acme-worker" "$acme_base" acme-worker

web_role=$(aws ecs describe-task-definition \
  --task-definition "$(jq -r --arg name "$WEB_SERVICE" '.services[] | select(.serviceName == $name) | .taskDefinition' <<<"$services")" \
  --query 'taskDefinition.taskRoleArn' --output text)
attached=$(aws iam list-attached-role-policies --role-name "${web_role##*/}" --output json)
has_attachment=$(jq -e --arg policy "$acme_policy" 'any(.AttachedPolicies[]?; .PolicyArn == $policy)' <<<"$attached" >/dev/null && printf true || printf false)
if [ "$has_attachment" != "$fallback" ]; then
  echo "platform task ACME policy attachment does not implement phase $PHASE" >&2
  exit 1
fi

policy_meta=$(aws iam get-policy --policy-arn "$application_policy" --output json)
policy_version=$(jq -r '.Policy.DefaultVersionId' <<<"$policy_meta")
policy_document=$(aws iam get-policy-version --policy-arn "$application_policy" \
  --version-id "$policy_version" --output json)
normalize_policy() {
  jq -Sc '
    def sorted_array:
      (if type == "array" then . else [.] end) | sort;
    def normalize_tree:
      if type == "object" then
        to_entries | sort_by(.key) | map(.value |= normalize_tree) | from_entries
      elif type == "array" then map(normalize_tree) | sort_by(tojson)
      else .
      end;
    if .Version != "2012-10-17" or (.Statement | type) != "array" then error("invalid policy")
    else {
      Version: .Version,
      Statement: ([.Statement[] |
        if
          (.Effect == "Allow") and has("Action") and has("Resource") and
          ((keys - ["Action", "Condition", "Effect", "Resource", "Sid"]) | length) == 0
        then {
          Effect: .Effect,
          Action: (.Action | sorted_array),
          Resource: (.Resource | sorted_array),
          Condition: ((.Condition // {}) | normalize_tree)
        }
        else error("unsupported or overbroad statement")
        end
      ] | sort_by(tojson))
    } end
  '
}
if ! reviewed_normalized=$(normalize_policy <<<"$reviewed_policy"); then
  echo "reviewed OpenTofu application policy cannot be normalized safely" >&2
  exit 1
fi
if ! live_normalized=$(jq -c '.PolicyVersion.Document' <<<"$policy_document" | normalize_policy); then
  echo "live application policy contains unsupported Deny, wildcard, or alternate grant semantics" >&2
  exit 1
fi
if [ "$live_normalized" != "$reviewed_normalized" ]; then
  echo "live application policy is not semantically identical to the reviewed OpenTofu policy" >&2
  exit 1
fi

echo "live ECS and IAM state exactly implement ACME rollout phase $PHASE"
