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
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$PLAN_JSON"' >"$TMP/bin/tofu"
chmod +x "$TMP/bin/tofu"

state() {
  case "$1" in
    A) printf '%s' '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}' ;;
    B) printf '%s' '{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":true}' ;;
    C) printf '%s' '{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":true}' ;;
    D) printf '%s' '{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":false}' ;;
  esac
}

plan() {
  local before=$1 after=$2 changes=$3 before_json
  if [ "$before" = NONE ]; then before_json=null; else before_json=$(state "$before"); fi
  jq -nc --argjson before "$before_json" --argjson after "$(state "$after")" \
    --argjson changes "$changes" '{
      output_changes: {acme_worker_rollout_state: {before: $before, after: $after}},
      resource_changes: [$changes[] | {address: .[0], change: {actions: .[1]}}]
    }'
}

run_check() {
  PLAN_JSON=$1 PATH="$TMP/bin:$PATH" "$ROOT/bin/check-acme-worker-rollout-plan.sh" ignored.tfplan
}

capacity='[["aws_ecs_service.acme_worker",["update"]],["aws_ecs_task_definition.web",["delete","create"]]]'
ownership='[["aws_ecs_task_definition.web",["delete","create"]]]'
remove_iam='[["aws_iam_policy.application",["update"]],["aws_iam_role_policy_attachment.task_acme_worker[0]",["delete"]]]'
restore_iam='[["aws_iam_policy.application",["update"]],["aws_iam_role_policy_attachment.task_acme_worker[0]",["create"]]]'
bootstrap='[["aws_ecs_service.acme_worker",["create"]],["aws_ecs_task_definition.acme_worker",["create"]],["aws_ecs_task_definition.web",["delete","create"]]]'

test "$(run_check "$(plan NONE A "$bootstrap")")" = 'NONE->A'
test "$(run_check "$(plan A B "$capacity")")" = 'A->B'
test "$(run_check "$(plan B C "$ownership")")" = 'B->C'
test "$(run_check "$(plan C D "$remove_iam")")" = 'C->D'
test "$(run_check "$(plan D C "$restore_iam")")" = 'D->C'
test "$(run_check "$(plan C B "$ownership")")" = 'C->B'
test "$(run_check "$(plan B A "$capacity")")" = 'B->A'

for transition in 'A D' 'D A' 'A C' 'C A' 'B D' 'D B' 'A A'; do
  set -- $transition
  if run_check "$(plan "$1" "$2" '[]')" >"$TMP/skip.out" 2>&1; then
    echo "plan guard accepted non-adjacent $1->$2" >&2
    exit 1
  fi
  grep -q 'only adjacent transitions are allowed' "$TMP/skip.out"
done

unexpected=$(jq -nc --argjson base "$capacity" '$base + [["aws_lb_target_group.tenant_http[\"blue\"]",["update"]]]')
if run_check "$(plan A B "$unexpected")" >"$TMP/resource.out" 2>&1; then
  echo "plan guard accepted an out-of-phase target-group change" >&2
  exit 1
fi
grep -q 'outside the exact A->B allowlist' "$TMP/resource.out"

wrong_action='[["aws_ecs_service.acme_worker",["create"]],["aws_ecs_task_definition.web",["delete","create"]]]'
if run_check "$(plan A B "$wrong_action")" >"$TMP/action.out" 2>&1; then
  echo "plan guard accepted an allowed address with an out-of-phase action" >&2
  exit 1
fi
grep -q 'outside the exact A->B allowlist' "$TMP/action.out"

missing='[["aws_ecs_service.acme_worker",["update"]]]'
if run_check "$(plan A B "$missing")" >"$TMP/missing.out" 2>&1; then
  echo "plan guard accepted A->B without the critical web task contract" >&2
  exit 1
fi
grep -q 'omits transition-critical A->B changes' "$TMP/missing.out"

replacement='[["aws_iam_policy.application",["delete","create"]],["aws_iam_role_policy_attachment.task_acme_worker[0]",["delete"]]]'
if run_check "$(plan C D "$replacement")" >"$TMP/replacement.out" 2>&1; then
  echo "plan guard accepted an application-policy replacement" >&2
  exit 1
fi
grep -Eq 'outside the exact C->D allowlist|replaces aws_iam_policy.application' "$TMP/replacement.out"

echo "ACME saved-plan guard enforces adjacent phases and exact resource allowlists"
