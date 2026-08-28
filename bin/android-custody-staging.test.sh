#!/usr/bin/env bash
# Evaluate the exact OpenTofu locals that feed ECS task secrets and execution-role parameter ARNs.
# This catches the production failure where a missing SSM name enters a launchable task revision.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOFU_BIN=${TOFU_BIN:-tofu}
ACCOUNT_ID=471112590391

evaluate() {
  local expression=$1
  shift
  printf '%s\n' "$expression" | \
    "$TOFU_BIN" -chdir="$ROOT/tofu" console -var="aws_account_id=$ACCOUNT_ID" "$@"
}

default_api=$(evaluate 'jsonencode(local.ecs_android_api_parameter_names)')
default_worker=$(evaluate 'jsonencode(local.ecs_android_worker_parameter_names)')
enabled_api=$(evaluate 'jsonencode(local.ecs_android_api_parameter_names)' \
  -var=android_custody_delivery_enabled=true)
signer_enabled_worker=$(evaluate 'jsonencode(local.ecs_android_worker_parameter_names)' \
  -var=android_custody_delivery_enabled=true)
developer_enabled_api=$(evaluate 'jsonencode(local.ecs_android_api_parameter_names)' \
  -var=android_developer_registration_delivery_enabled=true)
developer_enabled_worker=$(evaluate 'jsonencode(local.ecs_android_worker_parameter_names)' \
  -var=android_developer_registration_delivery_enabled=true)
default_execution_arns=$(evaluate 'jsonencode([for arn in local.ecs_application_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])')
signer_execution_arns=$(evaluate 'jsonencode([for arn in local.ecs_application_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_custody_delivery_enabled=true)
developer_execution_arns=$(evaluate 'jsonencode([for arn in local.ecs_application_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_developer_registration_delivery_enabled=true)
task_deny_actions=$(evaluate 'jsonencode(local.ecs_task_parameter_store_deny_actions)')
task_deny_resources=$(evaluate 'jsonencode(local.ecs_task_parameter_store_deny_resources)')

[ "$default_api" = '"[]"' ] || {
  echo "Android custody staging failed: default API SSM references were $default_api" >&2
  exit 1
}
[ "$default_worker" = '"[]"' ] || {
  echo "Android custody staging failed: default worker SSM references were $default_worker" >&2
  exit 1
}
[ "$default_execution_arns" = '"[]"' ] || {
  echo "Android custody staging failed: default execution-role SSM ARNs were $default_execution_arns" >&2
  exit 1
}
[ "$enabled_api" = '"[\"APK_SIGNER_OPERATOR_TOKEN\",\"APK_SIGNER_TOKEN\"]"' ] || {
  echo "Android custody staging failed: enabled API SSM references were $enabled_api" >&2
  exit 1
}
[ "$signer_enabled_worker" = '"[]"' ] || {
  echo "Android custody staging failed: signer delivery also enabled worker references: $signer_enabled_worker" >&2
  exit 1
}
[ "$developer_enabled_api" = '"[]"' ] || {
  echo "Android custody staging failed: developer delivery also enabled API references: $developer_enabled_api" >&2
  exit 1
}
[ "$developer_enabled_worker" = '"[\"ANDROID_DEVELOPER_ID_STATUS_API_KEY\"]"' ] || {
  echo "Android custody staging failed: developer-enabled worker references were $developer_enabled_worker" >&2
  exit 1
}
expected_signer_arns='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application/APK_SIGNER_OPERATOR_TOKEN\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application/APK_SIGNER_TOKEN\"]"'
[ "$signer_execution_arns" = "$expected_signer_arns" ] || {
  echo "Android custody staging failed: signer execution-role resources were $signer_execution_arns" >&2
  exit 1
}
expected_developer_arns='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application/ANDROID_DEVELOPER_ID_STATUS_API_KEY\"]"'
[ "$developer_execution_arns" = "$expected_developer_arns" ] || {
  echo "Android custody staging failed: developer execution-role resources were $developer_execution_arns" >&2
  exit 1
}
expected_deny_actions='"[\"ssm:GetParameter\",\"ssm:GetParameters\",\"ssm:GetParametersByPath\"]"'
[ "$task_deny_actions" = "$expected_deny_actions" ] || {
  echo "Android custody staging failed: task-role deny actions were $task_deny_actions" >&2
  exit 1
}
expected_deny_resources='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application/*\"]"'
[ "$task_deny_resources" = "$expected_deny_resources" ] || {
  echo "Android custody staging failed: task-role deny does not cover both signer parameter ARNs: $task_deny_resources" >&2
  exit 1
}

# The task and execution role must both consume the gated locals. Evaluating the locals alone is
# not enough if a future edit bypasses them with a literal ARN.
grep -q 'for name in local.ecs_api_parameter_names' "$ROOT/tofu/ecs.tf"
grep -q 'for name in local.ecs_worker_parameter_names' "$ROOT/tofu/ecs.tf"
grep -q 'Resource = local.ecs_application_parameter_arns' "$ROOT/tofu/ecs.tf"
grep -q 'resource "aws_iam_role_policy" "ecs_task_no_parameter_store"' "$ROOT/tofu/ecs.tf"
grep -q 'Resource = local.ecs_task_parameter_store_deny_resources' "$ROOT/tofu/ecs.tf"

echo "Android custody default-off task-delivery plan contract passed"
