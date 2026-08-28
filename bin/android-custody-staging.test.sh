#!/usr/bin/env bash
# Evaluate the exact OpenTofu locals that render ECS secrets and execution-role SSM resources.
# This prevents an absent or wrong-surface parameter from entering a launchable task revision.
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

assert_equal() {
  local actual=$1 expected=$2 message=$3
  [ "$actual" = "$expected" ] || {
    echo "Android custody staging failed: $message: $actual" >&2
    exit 1
  }
}

android_filter='strcontains(secret.name, "APK_SIGNER") || strcontains(secret.name, "ANDROID_DEVELOPER")'

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

default_web_android=$(evaluate "jsonencode([for secret in concat(local.ecs_website_parameter_secrets, local.ecs_api_parameter_secrets, local.ecs_worker_parameter_secrets) : secret if $android_filter])")
signer_web_android=$(evaluate "jsonencode([for secret in concat(local.ecs_website_parameter_secrets, local.ecs_api_parameter_secrets, local.ecs_worker_parameter_secrets) : secret if $android_filter])" \
  -var=android_custody_delivery_enabled=true)
developer_web_android=$(evaluate "jsonencode([for secret in concat(local.ecs_website_parameter_secrets, local.ecs_api_parameter_secrets, local.ecs_worker_parameter_secrets) : secret if $android_filter])" \
  -var=android_developer_registration_delivery_enabled=true)

default_acme_android=$(evaluate "jsonencode([for secret in local.ecs_acme_worker_parameter_secrets : secret if $android_filter])")
signer_acme_android=$(evaluate "jsonencode([for secret in local.ecs_acme_worker_parameter_secrets : secret if $android_filter])" \
  -var=android_custody_delivery_enabled=true)
developer_acme_android=$(evaluate "jsonencode([for secret in local.ecs_acme_worker_parameter_secrets : secret if $android_filter])" \
  -var=android_developer_registration_delivery_enabled=true)

default_web_arns=$(evaluate 'jsonencode([for arn in local.ecs_web_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])')
signer_web_arns=$(evaluate 'jsonencode([for arn in local.ecs_web_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_custody_delivery_enabled=true)
developer_web_arns=$(evaluate 'jsonencode([for arn in local.ecs_web_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_developer_registration_delivery_enabled=true)
default_acme_arns=$(evaluate 'jsonencode([for arn in local.ecs_acme_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])')
signer_acme_arns=$(evaluate 'jsonencode([for arn in local.ecs_acme_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_custody_delivery_enabled=true)
developer_acme_arns=$(evaluate 'jsonencode([for arn in local.ecs_acme_parameter_arns : arn if strcontains(arn, "APK_SIGNER") || strcontains(arn, "ANDROID_DEVELOPER")])' \
  -var=android_developer_registration_delivery_enabled=true)

task_deny_actions=$(evaluate 'jsonencode(local.ecs_task_parameter_store_deny_actions)')
task_deny_resources=$(evaluate 'jsonencode(local.ecs_task_parameter_store_deny_resources)')

assert_equal "$default_api" '"[]"' 'default API references were not empty'
assert_equal "$default_worker" '"[]"' 'default worker references were not empty'
assert_equal "$enabled_api" '"[\"APK_SIGNER_OPERATOR_TOKEN\",\"APK_SIGNER_TOKEN\"]"' 'enabled API references were wrong'
assert_equal "$signer_enabled_worker" '"[]"' 'signer delivery also enabled worker references'
assert_equal "$developer_enabled_api" '"[]"' 'developer delivery also enabled API references'
assert_equal "$developer_enabled_worker" '"[\"ANDROID_DEVELOPER_ID_STATUS_API_KEY\"]"' 'developer-enabled worker references were wrong'

empty='"[]"'
for value in "$default_web_android" "$default_acme_android" "$signer_acme_android" "$developer_acme_android" \
  "$default_web_arns" "$default_acme_arns" "$signer_acme_arns" "$developer_acme_arns"; do
  assert_equal "$value" "$empty" 'an Android credential leaked onto a disabled or ACME surface'
done

expected_signer_secrets='"[{\"name\":\"APK_SIGNER_OPERATOR_TOKEN\",\"valueFrom\":\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody/APK_SIGNER_OPERATOR_TOKEN\"},{\"name\":\"APK_SIGNER_TOKEN\",\"valueFrom\":\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody/APK_SIGNER_TOKEN\"}]"'
assert_equal "$signer_web_android" "$expected_signer_secrets" 'rendered signer API secrets were wrong'
expected_developer_secrets='"[{\"name\":\"ANDROID_DEVELOPER_ID_STATUS_API_KEY\",\"valueFrom\":\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-worker/ANDROID_DEVELOPER_ID_STATUS_API_KEY\"}]"'
assert_equal "$developer_web_android" "$expected_developer_secrets" 'rendered ordinary-worker developer secret was wrong'

expected_signer_arns='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody/APK_SIGNER_OPERATOR_TOKEN\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody/APK_SIGNER_TOKEN\"]"'
assert_equal "$signer_web_arns" "$expected_signer_arns" 'web execution-role signer resources were wrong'
expected_developer_arns='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-worker/ANDROID_DEVELOPER_ID_STATUS_API_KEY\"]"'
assert_equal "$developer_web_arns" "$expected_developer_arns" 'web execution-role developer resource was wrong'

expected_deny_actions='"[\"ssm:GetParameter\",\"ssm:GetParameters\",\"ssm:GetParametersByPath\"]"'
assert_equal "$task_deny_actions" "$expected_deny_actions" 'task-role deny actions were wrong'
expected_deny_resources='"[\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/application/*\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-custody/*\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-worker\",\"arn:aws:ssm:us-east-1:471112590391:parameter/sproutos/android-worker/*\"]"'
assert_equal "$task_deny_resources" "$expected_deny_resources" 'task-role deny does not cover all three parameter paths'

# Ensure the task definitions and the two distinct execution roles consume the evaluated values.
grep -q 'local.ecs_api_parameter_secrets' "$ROOT/tofu/ecs.tf"
grep -q 'local.ecs_worker_parameter_secrets' "$ROOT/tofu/ecs.tf"
grep -q 'local.ecs_acme_worker_parameter_secrets' "$ROOT/tofu/ecs.tf"
grep -q 'Resource = local.ecs_web_parameter_arns' "$ROOT/tofu/ecs.tf"
grep -q 'Resource = local.ecs_acme_parameter_arns' "$ROOT/tofu/ecs.tf"
grep -q 'execution_role_arn = aws_iam_role.acme_execution.arn' "$ROOT/tofu/ecs.tf"
grep -q 'Resource = local.ecs_task_parameter_store_deny_resources' "$ROOT/tofu/ecs.tf"

echo "Android custody default-off task-delivery plan contract passed"
