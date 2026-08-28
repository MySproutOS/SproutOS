#!/usr/bin/env bash
# The one-time PPv2 readiness update is safe only while all four target groups are offline together.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: verify-tenant-edge-target-groups-empty.sh <saved.tfplan>" >&2
  exit 2
fi
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
plan_json=$(tofu -chdir="$TOFU_DIR" show -json "$1")
groups=$(jq -c '[
  .resource_changes[]
  | select(
      (.address | startswith("aws_lb_target_group.tenant_http[")) or
      (.address | startswith("aws_lb_target_group.tenant_https["))
    )
  | select(.change.actions == ["update"] or .change.actions == ["no-op"])
  | {arn: .change.before.arn, actions: .change.actions, before: .change.before.proxy_protocol_v2, after: .change.after.proxy_protocol_v2}
]' <<<"$plan_json")
if ! jq -e '
  length == 4 and
  (map(.arn) | unique | length) == 4 and
  all(.[];
    (.arn | type) == "string" and .after == true and
    ((.actions == ["update"] and .before == false) or
     (.actions == ["no-op"] and .before == true))
  )
' <<<"$groups" >/dev/null; then
  echo "foundation plan must converge all four tenant-edge target groups on PPv2 together" >&2
  exit 1
fi

router_asgs=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$NAME_PREFIX-router-blue" "$NAME_PREFIX-router-green" --output json)
if ! jq -e --arg blue "$NAME_PREFIX-router-blue" --arg green "$NAME_PREFIX-router-green" '
  ([.AutoScalingGroups[].AutoScalingGroupName] | sort) == ([$blue, $green] | sort)
' <<<"$router_asgs" >/dev/null; then
  echo "could not prove both relevant router Auto Scaling groups" >&2
  exit 1
fi

while IFS= read -r arn; do
  target_group=$(aws elbv2 describe-target-groups --target-group-arns "$arn" --output json)
  health=$(aws elbv2 describe-target-health --target-group-arn "$arn" --output json)
  if jq -e --arg arn "$arn" '
    any(.AutoScalingGroups[]; ((.TargetGroupARNs // []) | index($arn)) != null)
  ' <<<"$router_asgs" >/dev/null; then
    echo "tenant-edge target group is still attached to a router Auto Scaling group: $arn" >&2
    exit 1
  fi
  if ! jq -e '
    (.TargetGroups | length) == 1 and
    (.TargetGroups[0].LoadBalancerArns | length) == 0
  ' <<<"$target_group" >/dev/null ||
    ! jq -e '(.TargetHealthDescriptions | length) == 0' <<<"$health" >/dev/null; then
    echo "tenant-edge target group is associated or non-empty; refusing mixed PPv2 update: $arn" >&2
    exit 1
  fi
done < <(jq -r '.[].arn' <<<"$groups")

echo "all four tenant-edge target groups are empty, unattached, and converge on PPv2 together"
