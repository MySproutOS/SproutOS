#!/usr/bin/env bash
# Static invariants for the Android custody boundary. Provider validation checks syntax and schema;
# these assertions prevent a future broad IAM/lifecycle cleanup from erasing the properties that
# make per-app signing keys recoverable.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ANDROID_TF="$ROOT/tofu/android-signing.tf"
COMPUTE_TF="$ROOT/tofu/compute.tf"
ECS_TF="$ROOT/tofu/ecs.tf"

require() {
  local pattern=$1 file=$2 message=$3
  if ! grep -Eq "$pattern" "$file"; then
    echo "android signing infrastructure invariant failed: $message" >&2
    exit 1
  fi
}

reject() {
  local pattern=$1 file=$2 message=$3
  if grep -Eq "$pattern" "$file"; then
    echo "android signing infrastructure invariant failed: $message" >&2
    exit 1
  fi
}

require 'resource "aws_s3_bucket_versioning" "android_artifacts"' "$ANDROID_TF" \
  'the Android artifact bucket must be versioned'
require 'force_destroy = false' "$ANDROID_TF" \
  'the Android custody bucket must refuse recursive destruction'
require 'prefix = "keys/"' "$ANDROID_TF" \
  'encrypted per-app signing keys need their own non-expiring lifecycle rule'
require 'prevent_destroy = true' "$ANDROID_TF" \
  'the Android custody bucket and KMS key must resist accidental destruction'
require 'aws:SecureTransport.*false' "$ANDROID_TF" \
  'the bucket must refuse plaintext transport'
require 'DenyExplicitEncryptionOverride' "$ANDROID_TF" \
  'a presigned PUT must not override the dedicated SSE-KMS bucket default'
require 'DenyCustomerProvidedEncryption' "$ANDROID_TF" \
  'a presigned PUT must not make an artifact depend on a caller-provided S3 key'
require 'DenyServerSideCopies' "$ANDROID_TF" \
  'a presigned PUT must not become a cross-prefix CopyObject capability'
KEY_RETENTION=$(sed -n '/id     = "retain-encrypted-signing-keys"/,/^}/p' "$ANDROID_TF")
reject '^[[:space:]]*(noncurrent_version_)?expiration[[:space:]]*\{' \
  <(printf '%s\n' "$KEY_RETENTION") \
  'no current or noncurrent encrypted signing-key version may expire'
require '"s3:GetObjectVersion"' "$ANDROID_TF" \
  'the API must be able to fetch exact artifact versions recorded in Postgres'
ANDROID_RAW_SIGNED_POLICY=$(sed -n '/resource "aws_iam_policy" "android_custody_broker"/,/Keep recovery-sensitive encrypted keys/p' "$ANDROID_TF")
require '"s3:GetObjectVersion"' <(printf '%s\n' "$ANDROID_RAW_SIGNED_POLICY") \
  'raw and signed artifact reads must support the exact S3 VersionId recorded in Postgres'
ANDROID_CUSTODY_POLICY=$(sed -n '/resource "aws_iam_policy" "android_custody_broker"/,/^}/p' "$ANDROID_TF")
reject 'android_artifacts\.arn}/\*' <(printf '%s\n' "$ANDROID_CUSTODY_POLICY") \
  'Android S3 authority must stay scoped to raw, keys, and signed prefixes'
reject 's3:DeleteObject' <(printf '%s\n' "$ANDROID_CUSTODY_POLICY") \
  'the application task must not be able to delete Android signing material'
require 'kms:EncryptionContext:aws:s3:arn' <(printf '%s\n' "$ANDROID_CUSTODY_POLICY") \
  'KMS use must be bound to the Android bucket encryption context'
reject 'cloudwatch:PutMetricData' <(printf '%s\n' "$ANDROID_CUSTODY_POLICY") \
  'do not grant metric publication before the durable signer-health producer exists'
SHARED_APPLICATION_POLICY=$(sed -n '/resource "aws_iam_policy" "application"/,/^}/p' "$COMPUTE_TF")
reject 'android_artifacts|android_custody' <(printf '%s\n' "$SHARED_APPLICATION_POLICY") \
  'the shared legacy/router/ACME application policy must have no Android custody authority'
require 'resource "aws_iam_role_policy_attachment" "task_android_custody_broker"' "$ANDROID_TF" \
  'Android object custody must have a dedicated task-role attachment'
ANDROID_CUSTODY_ATTACHMENT=$(sed -n \
  '/resource "aws_iam_role_policy_attachment" "task_android_custody_broker"/,/^}/p' "$ANDROID_TF")
require 'role[[:space:]]*=[[:space:]]*aws_iam_role.task.name' \
  <(printf '%s\n' "$ANDROID_CUSTODY_ATTACHMENT") \
  'only the ordinary control-plane task role may receive Android custody access'
reject 'aws_iam_role\.(instance|router|acme_worker)' \
  <(printf '%s\n' "$ANDROID_CUSTODY_ATTACHMENT") \
  'legacy, router, and ACME roles must not receive Android custody access'
API_PARAMETERS=$(sed -n '/ecs_api_parameter_names = \[/,/^  ]/p' "$ECS_TF")
WEBSITE_PARAMETERS=$(sed -n '/ecs_website_parameter_names = \[/,/^  ]/p' "$ECS_TF")
WORKER_PARAMETERS=$(sed -n '/ecs_worker_base_parameter_names = \[/,/^  ]/p' "$ECS_TF")
ACME_PARAMETERS=$(sed -n '/ecs_acme_worker_parameter_names = /p' "$ECS_TF")
ANDROID_API_PARAMETERS=$(sed -n '/ecs_android_api_parameter_names = /,/^  ] : \[\]/p' "$ECS_TF")
ANDROID_WORKER_PARAMETERS=$(sed -n '/ecs_android_worker_parameter_names = /,/^  ] : \[\]/p' "$ECS_TF")
NORMAL_UPLOAD_KEYS=$(sed -n '/^KEYS=(/,/^)/p' "$ROOT/bin/put-app-secrets.sh")
for token in APK_SIGNER_TOKEN APK_SIGNER_OPERATOR_TOKEN; do
  require "\"$token\"" <(printf '%s\n' "$ANDROID_API_PARAMETERS") \
    "$token must reach only the API verifier from Parameter Store"
  reject "\"$token\"" <(printf '%s\n' "$WEBSITE_PARAMETERS") \
    "$token must not reach the website container"
  reject "\"$token\"" <(printf '%s\n' "$WORKER_PARAMETERS") \
    "$token must not reach the worker container"
  reject "\"$token\"" <(printf '%s\n' "$ACME_PARAMETERS") \
    "$token must not reach the ACME container"
  require "^[[:space:]]*$token$" "$ROOT/bin/put-app-secrets.sh" \
    "$token must use the out-of-state Parameter Store delivery path"
  reject "^[[:space:]]*$token$" <(printf '%s\n' "$NORMAL_UPLOAD_KEYS") \
    "$token must not be copied to /application by an ordinary secret refresh"
done
require 'ANDROID_DEVELOPER_ID_STATUS_API_KEY' <(printf '%s\n' "$ANDROID_WORKER_PARAMETERS") \
  'the Android Developer Console credential must reach only the worker'
reject 'ANDROID_DEVELOPER_ID_STATUS_API_KEY' <(printf '%s\n' "$API_PARAMETERS$WEBSITE_PARAMETERS") \
  'the Android Developer Console credential must not reach the API or website'
reject 'ecs_worker_parameter_names' <(printf '%s\n' "$ACME_PARAMETERS") \
  'the ACME task must not inherit the ordinary worker secret list'
require 'var.android_custody_delivery_enabled[[:space:]]*\?' "$ECS_TF" \
  'both signer task-secret references must remain behind their explicit second-stage gate'
require 'var.android_developer_registration_delivery_enabled[[:space:]]*\?' "$ECS_TF" \
  'the independent Google credential must remain behind its own second-stage gate'
require 'variable "android_custody_delivery_enabled"' "$ROOT/tofu/variables.tf" \
  'Android custody delivery needs an explicit rollout variable'
require 'default[[:space:]]*=[[:space:]]*false' \
  <(sed -n '/variable "android_custody_delivery_enabled"/,/^}/p' "$ROOT/tofu/variables.tf") \
  'a normal first apply must not register missing Android SSM references'
require 'variable "android_developer_registration_delivery_enabled"' "$ROOT/tofu/variables.tf" \
  'the Google developer credential must not be coupled to signer-token delivery'
require 'default[[:space:]]*=[[:space:]]*false' \
  <(sed -n '/variable "android_developer_registration_delivery_enabled"/,/^}/p' "$ROOT/tofu/variables.tf") \
  'Google developer credential delivery must stay disabled by default'
require 'ANDROID_CUSTODY_ONLY' "$ROOT/bin/put-app-secrets.sh" \
  'custody parameters need an all-or-nothing out-of-state upload mode'
require 'APK_SIGNER_TOKEN.*APK_SIGNER_OPERATOR_TOKEN must differ' "$ROOT/bin/put-app-secrets.sh" \
  'the out-of-state upload must reject equal runtime and operator credentials'
require 'ANDROID_ARTIFACT_BUCKET.*android_artifacts' "$ECS_TF" \
  'the API and worker need the dedicated bucket name rather than the general build bucket'
for dependency in \
  aws_s3_bucket_versioning.android_artifacts \
  aws_s3_bucket_server_side_encryption_configuration.android_artifacts \
  aws_s3_bucket_policy.android_artifacts \
  aws_iam_role_policy_attachment.task_application \
  aws_iam_role_policy_attachment.task_android_custody_broker \
  aws_iam_role_policy.ecs_execution_secrets \
  aws_iam_role_policy.ecs_task_no_parameter_store; do
  require "$dependency" "$ECS_TF" \
    "the ECS task definition must wait for $dependency before registration"
done
TASK_PARAMETER_DENY=$(sed -n \
  '/resource "aws_iam_role_policy" "ecs_task_no_parameter_store"/,/^}/p' "$ECS_TF")
require 'role[[:space:]]*=[[:space:]]*aws_iam_role.task.id' \
  <(printf '%s\n' "$TASK_PARAMETER_DENY") \
  'the shared application task role itself must carry the Parameter Store deny'
require 'Action[[:space:]]*=[[:space:]]*local.ecs_task_parameter_store_deny_actions' \
  <(printf '%s\n' "$TASK_PARAMETER_DENY") \
  'the task role deny must consume the exact actions evaluated by the staging test'
for action in ssm:GetParameter ssm:GetParameters ssm:GetParametersByPath; do
  require "\"$action\"" "$ECS_TF" \
    "the task role must deny $action so sibling containers cannot fetch API-only tokens"
done
require 'Resource[[:space:]]*=[[:space:]]*local.ecs_task_parameter_store_deny_resources' \
  <(printf '%s\n' "$TASK_PARAMETER_DENY") \
  'the runtime deny must cover the application and isolated custody parameter paths'
EXECUTION_POLICY=$(sed -n \
  '/resource "aws_iam_role_policy" "ecs_execution_secrets"/,/^}/p' "$ECS_TF")
require 'Action[[:space:]]*=[[:space:]]*\["ssm:GetParameters"\]' \
  <(printf '%s\n' "$EXECUTION_POLICY") \
  'the ECS execution role may use only the batch read needed for injected secrets'
require 'Resource[[:space:]]*=[[:space:]]*local.ecs_web_parameter_arns' \
  <(printf '%s\n' "$EXECUTION_POLICY") \
  'the ECS execution role must remain scoped to exact enabled task-secret ARNs'
ACME_EXECUTION_POLICY=$(sed -n \
  '/resource "aws_iam_role_policy" "acme_execution_secrets"/,/^}/p' "$ECS_TF")
require 'Resource[[:space:]]*=[[:space:]]*local.ecs_acme_parameter_arns' \
  <(printf '%s\n' "$ACME_EXECUTION_POLICY") \
  'the ACME execution role must remain scoped to its separate ordinary-secret list'
require 'execution_role_arn[[:space:]]*=[[:space:]]*aws_iam_role.acme_execution.arn' "$ECS_TF" \
  'the ACME task must not share the web execution role'
require 'ecs_acme_worker_parameter_names[[:space:]]*=[[:space:]]*local.ecs_worker_base_parameter_names' "$ECS_TF" \
  'the ACME task must exclude the independently gated Google credential'
require 'ANDROID_CUSTODY_PARAMETER_PATH' "$ROOT/bin/put-app-secrets.sh" \
  'signer credentials must use their isolated Parameter Store path'
require '/sproutos/android-custody' "$ROOT/bin/put-app-secrets.sh" \
  'the custody-only upload must default to the isolated production path'
require '/sproutos/android-worker' "$ROOT/bin/put-app-secrets.sh" \
  'the Google worker credential must default to its isolated production path'
require 'local.android_worker_parameter_path' "$ECS_TF" \
  'the worker task must inject the Google key from its isolated path'
if git -C "$ROOT" grep -E 'APK_SIGNER_MASTER_IDENTITY|master\.pem|PKCS.?8' -- \
  'tofu/*.tf' 'tofu/*.tftpl' '.github/workflows/*.yml' >/dev/null; then
  echo 'android signing infrastructure invariant failed: the offline master identity must not enter AWS or CI configuration' >&2
  exit 1
fi
require 'variable "android_signing_alarms_enabled"' "$ROOT/tofu/variables.tf" \
  'alarm creation must remain behind an explicit rollout switch'
require 'default[[:space:]]*=[[:space:]]*false' \
  <(sed -n '/variable "android_signing_alarms_enabled"/,/^}/p' "$ROOT/tofu/variables.tf") \
  'signing alarms must stay disabled until the last-seen and queue metric producers exist'
for metric in SignerHeartbeatAgeSeconds OldestQueuedJobAgeSeconds FailedJobs; do
  require "metric_name[[:space:]]*=[[:space:]]*\"$metric\"" "$ANDROID_TF" \
    "the alarm contract must name the $metric producer prerequisite"
done
reject 'kms_master_key_id[[:space:]]*=[[:space:]]*"alias/aws/sns"' "$ANDROID_TF" \
  'CloudWatch cannot be granted use of the immutable AWS-managed SNS key policy'
require 'AllowCloudWatchAlarmPublishing' "$ANDROID_TF" \
  'the conditional alarm key must authorize only the CloudWatch alarm publisher'
require 'land a durable signer registry/last-seen record and a scheduled queue-health sampler' \
  "$ROOT/docs/android-signing-infrastructure.md" \
  'operators must be told that last-seen and queue metrics do not exist yet'
require 'bin/handoff-ecs-task-definitions\.sh' "$ROOT/docs/android-signing-infrastructure.md" \
  'stage two must explicitly deploy the registered task with the existing immutable pre-192 image'
require 'ignore_changes.*task_definition' "$ROOT/docs/android-signing-infrastructure.md" \
  'the runbook must explain why applying the saved plan does not update the live ECS service'

echo 'Android signing infrastructure invariants passed'
