#!/usr/bin/env bash
# Accept only one adjacent ACME rollout phase and only the resources owned by that phase.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: check-acme-worker-rollout-plan.sh <saved.tfplan>" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
case "$1" in
  /*) PLAN=$1 ;;
  *) PLAN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")" ;;
esac
plan_json=$(tofu -chdir="$TOFU_DIR" show -json "$PLAN")

phase_of() {
  jq -r '
    if . == null then "NONE"
    elif .capacity_enabled == false and .handler_ownership_enabled == false and .fallback_iam_enabled == true then "A"
    elif .capacity_enabled == true and .handler_ownership_enabled == false and .fallback_iam_enabled == true then "B"
    elif .capacity_enabled == true and .handler_ownership_enabled == true and .fallback_iam_enabled == true then "C"
    elif .capacity_enabled == true and .handler_ownership_enabled == true and .fallback_iam_enabled == false then "D"
    else "INVALID"
    end
  '
}

before_state=$(jq -c '.output_changes.acme_worker_rollout_state.before' <<<"$plan_json")
after_state=$(jq -c '.output_changes.acme_worker_rollout_state.after' <<<"$plan_json")
before_phase=$(phase_of <<<"$before_state")
after_phase=$(phase_of <<<"$after_state")
transition="$before_phase->$after_phase"

case "$transition" in
  "NONE->A"|"A->B"|"B->C"|"C->D"|"D->C"|"C->B"|"B->A") ;;
  *"->INVALID"|"INVALID->"*)
    echo "saved plan has an invalid ACME rollout state ($transition)" >&2
    exit 1
    ;;
  *)
    echo "saved plan skips an ACME rollout phase ($transition); only adjacent transitions are allowed" >&2
    exit 1
    ;;
esac

expected_changes() {
  case "$transition" in
    "NONE->A")
      # One-time foundation/bootstrap from the pre-gate state. This is intentionally exact: any
      # drift or newly coupled edge resource requires a new review instead of hitching a ride.
      printf '%s\n' \
        'aws_autoscaling_policy.router_tenant_edge["blue"]|delete' \
        'aws_autoscaling_policy.router_tenant_edge["green"]|delete' \
        'aws_ecs_service.acme_worker|create' \
        'aws_ecs_service.web|update' \
        'aws_ecs_task_definition.acme_worker|create' \
        'aws_ecs_task_definition.web|delete,create' \
        'aws_iam_instance_profile.router|create' \
        'aws_iam_policy.acme_worker|update' \
        'aws_iam_policy.application|update' \
        'aws_iam_policy.control_plane_dns|create' \
        'aws_iam_policy.router_certificate_read|create' \
        'aws_iam_role.acme_execution|create' \
        'aws_iam_role.acme_task|create' \
        'aws_iam_role.router_instance|create' \
        'aws_iam_role_policy.acme_execution_secrets|create' \
        'aws_iam_role_policy.ecs_task_no_parameter_store|create' \
        'aws_iam_role_policy_attachment.acme_execution|create' \
        'aws_iam_role_policy_attachment.acme_task_application|create' \
        'aws_iam_role_policy_attachment.acme_task_control_plane_dns|create' \
        'aws_iam_role_policy_attachment.acme_task_worker|create' \
        'aws_iam_role_policy_attachment.router_instance_application|create' \
        'aws_iam_role_policy_attachment.router_instance_certificate_read|create' \
        'aws_iam_role_policy_attachment.router_instance_ssm|create' \
        'aws_launch_template.ecs|update' \
        'aws_launch_template.service["router"]|update' \
        'aws_launch_template.service["website"]|update' \
        'aws_lb_target_group.tenant_http["blue"]|update' \
        'aws_lb_target_group.tenant_http["green"]|update' \
        'aws_lb_target_group.tenant_https["blue"]|update' \
        'aws_lb_target_group.tenant_https["green"]|update' \
        'aws_security_group.tenant_edge_nlb|create' \
        'aws_vpc_security_group_egress_rule.tenant_edge_nlb_out|create' \
        'aws_vpc_security_group_ingress_rule.service_tenant_edge_readiness_from_nlb|create' \
        'aws_vpc_security_group_ingress_rule.service_tenant_http_from_nlb|update' \
        'aws_vpc_security_group_ingress_rule.service_tenant_https_from_nlb|update' \
        'terraform_data.tenant_edge_mode|delete'
      ;;
    "A->B"|"B->A")
      printf '%s\n' \
        'aws_ecs_service.acme_worker|update' \
        'aws_ecs_task_definition.web|delete,create'
      ;;
    "B->C"|"C->B")
      printf '%s\n' 'aws_ecs_task_definition.web|delete,create'
      ;;
    "C->D")
      printf '%s\n' \
        'aws_iam_policy.application|update' \
        'aws_iam_role_policy_attachment.task_acme_worker[0]|delete'
      ;;
    "D->C")
      printf '%s\n' \
        'aws_iam_policy.application|update' \
        'aws_iam_role_policy_attachment.task_acme_worker[0]|create'
      ;;
  esac
}

actual_changes=$(jq -r '
  .resource_changes[]
  | select(.change.actions != ["no-op"])
  | "\(.address)|\(.change.actions | join(","))"
' <<<"$plan_json" | LC_ALL=C sort)
allowed_changes=$(expected_changes | LC_ALL=C sort)
if [ "$actual_changes" != "$allowed_changes" ]; then
  echo "saved plan contains resources outside the exact $transition allowlist" >&2
  diff -u <(printf '%s\n' "$allowed_changes") <(printf '%s\n' "$actual_changes") >&2 || true
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

echo "$transition"
