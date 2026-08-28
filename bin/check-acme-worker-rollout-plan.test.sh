#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
cleanup() {
  find "$TMP" -type f -delete
  rmdir "$TMP/bin" 2>/dev/null || true
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

mkdir "$TMP/bin"
cat >"$TMP/bin/tofu" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$PLAN_JSON"
STUB
chmod +x "$TMP/bin/tofu"

run_check() {
  PLAN_JSON=$1 PATH="$TMP/bin:$PATH" "$ROOT/bin/check-acme-worker-rollout-plan.sh" ignored.tfplan
}

safe_plan() {
  jq -nc --argjson state "$1" --argjson actions "$2" --argjson attachment "$3" '{
    planned_values: {outputs: {acme_worker_rollout_state: {value: $state}}},
    resource_changes: [
      {address: "aws_iam_policy.application", change: {actions: $actions}},
      {address: "aws_iam_role_policy_attachment.task_acme_worker[0]", change: {actions: $attachment}}
    ]
  }'
}

run_check "$(safe_plan \
  '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}' \
  '["update"]' '["no-op"]')"
run_check "$(safe_plan \
  '{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":false}' \
  '["update"]' '["delete"]')"

if run_check "$(safe_plan \
  '{"capacity_enabled":false,"handler_ownership_enabled":true,"fallback_iam_enabled":true}' \
  '["update"]' '["no-op"]')" >"$TMP/zero-owner.out" 2>&1; then
  echo "plan check accepted isolated ownership without capacity" >&2
  exit 1
fi
grep -q "zero owners" "$TMP/zero-owner.out"

if run_check "$(safe_plan \
  '{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":false}' \
  '["update"]' '["delete"]')" >"$TMP/no-iam.out" 2>&1; then
  echo "plan check accepted platform ownership without fallback IAM" >&2
  exit 1
fi
grep -q "removes fallback IAM" "$TMP/no-iam.out"

if run_check "$(safe_plan \
  '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}' \
  '["delete","create"]' '["no-op"]')" >"$TMP/replacement.out" 2>&1; then
  echo "plan check accepted application policy replacement" >&2
  exit 1
fi
grep -q "replaces aws_iam_policy.application" "$TMP/replacement.out"

if run_check "$(safe_plan \
  '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}' \
  '["update"]' '["delete"]')" >"$TMP/attachment.out" 2>&1; then
  echo "plan check accepted fallback attachment deletion" >&2
  exit 1
fi
grep -q "does not preserve the platform task ACME policy attachment" "$TMP/attachment.out"

echo "ACME saved-plan guard rejects every unsafe rollout state"
