#!/usr/bin/env bash
# Reject a saved plan which creates an ownership/IAM gap or replaces the shared application policy.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: check-acme-worker-rollout-plan.sh <saved.tfplan>" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
plan_json=$(tofu -chdir="$TOFU_DIR" show -json "$1")
rollout_state=$(jq -c '.planned_values.outputs.acme_worker_rollout_state.value' <<<"$plan_json")

capacity_enabled=$(jq -r '.capacity_enabled' <<<"$rollout_state")
handler_ownership_enabled=$(jq -r '.handler_ownership_enabled' <<<"$rollout_state")
fallback_iam_enabled=$(jq -r '.fallback_iam_enabled' <<<"$rollout_state")
for value in "$capacity_enabled" "$handler_ownership_enabled" "$fallback_iam_enabled"; do
  if [ "$value" != "true" ] && [ "$value" != "false" ]; then
    echo "saved plan has malformed ACME rollout gates" >&2
    exit 1
  fi
done
if [ "$handler_ownership_enabled" = "true" ] && [ "$capacity_enabled" != "true" ]; then
  echo "saved plan has zero owners: isolated ownership requires worker capacity" >&2
  exit 1
fi
if [ "$handler_ownership_enabled" = "false" ] && [ "$fallback_iam_enabled" != "true" ]; then
  echo "saved plan removes fallback IAM while the platform owns privileged handlers" >&2
  exit 1
fi

if jq -e '
  any(.resource_changes[]?;
    .address == "aws_iam_policy.application" and
    (.change.actions | index("delete") != null and index("create") != null)
  )
' <<<"$plan_json" >/dev/null; then
  echo "saved plan replaces aws_iam_policy.application; preserve its immutable description" >&2
  exit 1
fi

if [ "$fallback_iam_enabled" = "true" ] && ! jq -e '
  any(.resource_changes[]?;
    .address == "aws_iam_role_policy_attachment.task_acme_worker[0]" and
    (.change.actions == ["no-op"] or .change.actions == ["create"])
  )
' <<<"$plan_json" >/dev/null; then
  echo "saved plan does not preserve the platform task ACME policy attachment" >&2
  exit 1
fi

echo "saved plan preserves ACME handler ownership and fallback IAM"
