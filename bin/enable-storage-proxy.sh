#!/usr/bin/env bash
#
# Complete the deliberately two-stage first rollout of storage-proxy.
#
# OpenTofu first deploys its rule and target groups detached (`storage_proxy_enabled=false`) so an
# unserved ELB health check cannot recycle healthy router instances. After a router release that
# contains the binary, apply with `storage_proxy_enabled=true`, then run this script. It discovers
# the colour serving router traffic, requires that colour's storage target group to be attached and
# healthy, and points the staged storage rule at that same colour. Only after this succeeds should
# `STORAGE_RULE_ARN` be added to the deploy workflow's repository variables.
set -euo pipefail

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${LISTENER_ARN:?LISTENER_ARN is not set}"
: "${STORAGE_RULE_ARN:?STORAGE_RULE_ARN is not set}"

group_arn() {
  aws elbv2 describe-target-groups \
    --names "$NAME_PREFIX-$1-$2" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text
}

router_blue=$(group_arn router blue)
router_green=$(group_arn router green)
live_router=$(aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" \
  --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
  --output text)

case "$live_router" in
  "$router_blue") live_colour=blue; other_colour=green ;;
  "$router_green") live_colour=green; other_colour=blue ;;
  *)
    echo "router listener points at neither target group; refusing to guess" >&2
    exit 1
    ;;
esac

storage_live=$(group_arn storage "$live_colour")
storage_other=$(group_arn storage "$other_colour")

# Both colours must be enrolled before the rule is made live. The idle colour normally has zero
# instances and therefore cannot be healthy yet, but its ASG must already carry the storage target
# group. Otherwise the next deployment skips storage on the idle side, moves router traffic there,
# and drains the only ASG still serving the storage rule.
for colour in "$live_colour" "$other_colour"; do
  case "$colour" in
    "$live_colour") storage_group=$storage_live ;;
    *) storage_group=$storage_other ;;
  esac
  attached=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$NAME_PREFIX-router-$colour" \
    --query "contains(AutoScalingGroups[0].TargetGroupARNs, '$storage_group')" \
    --output text)
  case "$attached" in
    True|true) ;;
    False|false)
      echo "storage target group is not attached to the $colour router ASG; apply storage_proxy_enabled=true first" >&2
      exit 1
      ;;
    *)
      echo "could not determine whether the $colour storage target group is attached (got: '$attached')" >&2
      exit 1
      ;;
  esac
done

healthy=$(aws elbv2 describe-target-health --target-group-arn "$storage_live" \
  --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)
if ! [[ "$healthy" =~ ^[0-9]+$ ]] || [ "$healthy" -lt 1 ]; then
  echo "storage has no confirmed healthy target on live router colour $live_colour (got: '$healthy')" >&2
  exit 1
fi

action=$(printf '[{"Type":"forward","ForwardConfig":{"TargetGroups":[{"TargetGroupArn":"%s","Weight":100},{"TargetGroupArn":"%s","Weight":0}]}}]' \
  "$storage_live" "$storage_other")
aws elbv2 modify-rule --rule-arn "$STORAGE_RULE_ARN" --actions "$action" >/dev/null

settled=$(aws elbv2 describe-rules --rule-arns "$STORAGE_RULE_ARN" \
  --query 'Rules[0].Actions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
  --output text)
if [ "$settled" != "$storage_live" ]; then
  echo "storage rule reconciliation did not stick: rule now points at $settled" >&2
  exit 1
fi

echo "storage-proxy enabled on $live_colour ($healthy healthy target(s)); rule and router agree"
