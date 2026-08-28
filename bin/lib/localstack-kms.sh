#!/usr/bin/env bash

# Ensure one KMS alias without treating an eventually consistent read or a concurrent creator as
# a fatal bootstrap failure. The caller supplies `aws_local`, so this stays testable without AWS.
ensure_localstack_kms_alias() {
  local alias_name=$1
  local description=$2
  local retry_delay=${LOCALSTACK_KMS_RETRY_DELAY_SECONDS:-0.2}
  local attempt

  # LocalStack can restore an alias before `DescribeKey` starts returning it. A short bounded retry
  # avoids creating an unused key during that window.
  for attempt in 1 2 3; do
    if aws_local kms describe-key --key-id "$alias_name" >/dev/null 2>&1; then
      echo "KMS $alias_name already present"
      return 0
    fi
    if [[ "$attempt" != 3 ]]; then sleep "$retry_delay"; fi
  done

  local key_id
  key_id=$(aws_local kms create-key --description "$description" \
    --query 'KeyMetadata.KeyId' --output text)

  local create_error
  if create_error=$(aws_local kms create-alias \
    --alias-name "$alias_name" --target-key-id "$key_id" 2>&1); then
    echo "created KMS key $key_id ($alias_name)"
    return 0
  fi

  # Another bootstrap may have won after our final read. Confirm the desired postcondition rather
  # than failing because its CreateAlias reached LocalStack first.
  if aws_local kms describe-key --key-id "$alias_name" >/dev/null 2>&1; then
    echo "KMS $alias_name was created concurrently"
    return 0
  fi

  printf '%s\n' "$create_error" >&2
  return 1
}
