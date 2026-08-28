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
require 'prefix = "keys/"' "$ANDROID_TF" \
  'encrypted per-app signing keys need their own non-expiring lifecycle rule'
require 'prevent_destroy = true' "$ANDROID_TF" \
  'the Android custody bucket and KMS key must resist accidental destruction'
require 'aws:SecureTransport.*false' "$ANDROID_TF" \
  'the bucket must refuse plaintext transport'
require '"s3:GetObjectVersion"' "$COMPUTE_TF" \
  'the API must be able to fetch exact artifact versions recorded in Postgres'
ANDROID_RAW_SIGNED_POLICY=$(sed -n '/Android release custody/,/Encrypted key objects/p' "$COMPUTE_TF")
require '"s3:GetObjectVersion"' <(printf '%s\n' "$ANDROID_RAW_SIGNED_POLICY") \
  'raw and signed artifact reads must support the exact S3 VersionId recorded in Postgres'
reject 'android_artifacts\.arn}/\*' "$COMPUTE_TF" \
  'Android S3 authority must stay scoped to raw, keys, and signed prefixes'
reject 's3:DeleteObject' <(sed -n '/Android release custody/,/A PUT needs GenerateDataKey/p' "$COMPUTE_TF") \
  'the application task must not be able to delete Android signing material'
require '"APK_SIGNER_TOKEN"' "$ECS_TF" \
  'the API must load the signer bearer token from Parameter Store'
require 'ANDROID_ARTIFACT_BUCKET.*android_artifacts' "$ECS_TF" \
  'the API and worker need the dedicated bucket name rather than the general build bucket'
require 'variable "android_signing_alarms_enabled"' "$ROOT/tofu/variables.tf" \
  'alarm creation must remain behind an explicit rollout switch'
require 'default[[:space:]]*=[[:space:]]*false' \
  <(sed -n '/variable "android_signing_alarms_enabled"/,/^}/p' "$ROOT/tofu/variables.tf") \
  'signing alarms must stay disabled until the last-seen and queue metric producers exist'
for metric in SignerHeartbeatAgeSeconds OldestQueuedJobAgeSeconds FailedJobs; do
  require "metric_name[[:space:]]*=[[:space:]]*\"$metric\"" "$ANDROID_TF" \
    "the alarm contract must name the $metric producer prerequisite"
done
require 'land a durable signer registry/last-seen record and a scheduled queue-health sampler' \
  "$ROOT/docs/android-signing-infrastructure.md" \
  'operators must be told that last-seen and queue metrics do not exist yet'

echo 'Android signing infrastructure invariants passed'
