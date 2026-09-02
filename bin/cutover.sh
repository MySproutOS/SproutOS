#!/usr/bin/env bash
#
# Move one service's traffic from the colour serving it to the other.
#
# Blue/green here is two target groups per service, both attached to the listener, with all the
# weight on one of them. The deploy fills the idle group, waits for its own health checks to pass,
# and then this moves the weight. Rollback is this script again with no arguments — it always moves
# to whichever colour is not live, so "roll back" and "roll forward" are the same operation.
#
# Usage: cutover.sh <service> [--to blue|green] [--dry-run]
#   service   website | router
#
# Neither service moves one thing. `website` is the apex plus `api.<domain>`; `router` is the
# listener's default action plus its public protocol splits. In both cases those are different
# ports on the *same instances* from the *same release tarball*, so they are one deployment with
# several target groups. Moving them separately would be commands that can disagree — and a
# disagreement means the API is pointed at the colour the website just drained, or search is.
set -euo pipefail

SERVICE="${1:-}"
shift || true

TARGET=""
DRY_RUN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$SERVICE" in
  website|router) ;;
  *) echo "usage: cutover.sh <website|router> [--to blue|green] [--dry-run]" >&2; exit 2 ;;
esac

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${LISTENER_ARN:?LISTENER_ARN is not set}"

ASG_SCALE_RETRIES="${CUTOVER_ASG_SCALE_RETRIES:-5}"
ASG_SCALE_RETRY_DELAY="${CUTOVER_ASG_SCALE_RETRY_DELAY:-5}"
if ! [[ "$ASG_SCALE_RETRIES" =~ ^[1-9][0-9]*$ ]]; then
  echo "CUTOVER_ASG_SCALE_RETRIES must be a positive integer" >&2
  exit 2
fi
if ! [[ "$ASG_SCALE_RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  echo "CUTOVER_ASG_SCALE_RETRY_DELAY must be a non-negative integer" >&2
  exit 2
fi

# The website and the API are listener *rules* matched on host; the router is the listener's
# *default* action. That is the only place in this script the services differ, and it is why the
# rule ARN is required for two of the three and meaningless for the last.
# `RULE_ARN` decides the colour and is read back to confirm the move; `ALSO_MOVE` follows it
# without a vote. For the website that second rule is the API's, which has its own target groups on
# its own port but is never a different colour.
# `EXTRAS` is a list of `kind|short|arn`, moved to whatever colour the primary decides.
#
# `kind` is `rule` or `listener`, because the two take different AWS calls and the router now has
# both kinds: the search split is a *rule* on the application load balancer, and the wire-protocol
# splits are whole *listeners* on the network load balancer beside it. `short` names target groups,
# which are `$NAME_PREFIX-$short-$colour`.
#
# Every extra is optional. An estate with no OpenSearch behind it has no search rule, and one with
# no tenant load balancer has no Postgres listener; a cutover there should move the router rather
# than refuse, so an unset variable drops out of the list.
if [ "$SERVICE" = "website" ]; then
  : "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set}"
  : "${API_RULE_ARN:?API_RULE_ARN is not set}"
  RULE_ARN="$WEBSITE_RULE_ARN"
  EXTRAS="rule|api|$API_RULE_ARN"
  short=web
else
  RULE_ARN=""
  EXTRAS=""
  tenant_https_short="${TENANT_HTTPS_TARGET_GROUP_SHORT:-egress}"
  [ -n "${SEARCH_RULE_ARN:-}" ] && EXTRAS="$EXTRAS rule|search|$SEARCH_RULE_ARN"
  [ -n "${LLM_RULE_ARN:-}" ] && EXTRAS="$EXTRAS rule|llm|$LLM_RULE_ARN"
  [ -n "${PG_LISTENER_ARN:-}" ] && EXTRAS="$EXTRAS listener|pg|$PG_LISTENER_ARN"
  [ -n "${VALKEY_LISTENER_ARN:-}" ] && EXTRAS="$EXTRAS listener|valkey|$VALKEY_LISTENER_ARN"
  [ -n "${FORWARD_PROXY_LISTENER_ARN:-}" ] && EXTRAS="$EXTRAS listener|$tenant_https_short|$FORWARD_PROXY_LISTENER_ARN"
  [ -n "${FORWARD_PROXY_HTTP_LISTENER_ARN:-}" ] && EXTRAS="$EXTRAS listener|egress|$FORWARD_PROXY_HTTP_LISTENER_ARN"
  [ -n "${TENANT_HTTP_LISTENER_ARN:-}" ] && EXTRAS="$EXTRAS listener|edge-http|$TENANT_HTTP_LISTENER_ARN"
  short=router
fi

group_arn_of() {
  aws elbv2 describe-target-groups \
    --names "$NAME_PREFIX-$1-$2" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text
}

group_arn() { group_arn_of "$short" "$1"; }

# The target group currently carrying traffic: the one with a non-zero weight.
#
# The listener forwards to both colours with weights rather than naming one — see `compute.tf`, and
# the scaling policy that could not exist without it. So "which is live" is a weight, not an ARN.
current_arn() {
  if [ -n "$RULE_ARN" ]; then
    aws elbv2 describe-rules --rule-arns "$RULE_ARN" \
      --query 'Rules[0].Actions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
      --output text
  else
    aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" \
      --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
      --output text
  fi
}

# All the weight on one colour and none on the other. A partial shift is possible with this shape
# and is deliberately not what this does: a cutover that half-worked is harder to reason about at
# three in the morning than one that did or did not.
forward_action() {
  local live="$1" idle="$2"
  printf '[{"Type":"forward","ForwardConfig":{"TargetGroups":[{"TargetGroupArn":"%s","Weight":100},{"TargetGroupArn":"%s","Weight":0}]}}]' "$live" "$idle"
}

blue=$(group_arn blue)
green=$(group_arn green)
live=$(current_arn)

# Derived, never assumed. A script that took "we deployed to green, so cut to green" on faith would
# happily cut to the colour already serving — a no-op that reports success and ships nothing, which
# is worse than an error because the release looks done.
if [ -z "$TARGET" ]; then
  if [ "$live" = "$blue" ]; then
    TARGET=green
  elif [ "$live" = "$green" ]; then
    TARGET=blue
  else
    echo "the listener points at neither target group; refusing to guess" >&2
    echo "  live:  $live" >&2
    echo "  blue:  $blue" >&2
    echo "  green: $green" >&2
    exit 1
  fi
fi

case "$TARGET" in
  blue) target_arn="$blue" ;;
  green) target_arn="$green" ;;
  *) echo "--to must be blue or green" >&2; exit 2 ;;
esac

other_colour=$([ "$TARGET" = blue ] && echo green || echo blue)
target_asg="$NAME_PREFIX-$short-$TARGET"
drained_asg="$NAME_PREFIX-$short-$other_colour"

reconcile_scaling_processes() {
  # A drained NLB target group can report active flows until its five-minute connection drain
  # completes. Suspending AlarmNotification before scaling it to zero prevents that delayed metric
  # from resurrecting the idle fleet. The newly live colour is safe to resume: any alarm it sees
  # now represents traffic it actually serves.
  aws autoscaling suspend-processes \
    --auto-scaling-group-name "$drained_asg" \
    --scaling-processes AlarmNotification
  aws autoscaling resume-processes \
    --auto-scaling-group-name "$target_asg" \
    --scaling-processes AlarmNotification
}

# The storage rule may exist one deployment before its target groups are attached. This is the
# rollout interlock in `compute.tf`: including an unserved target group in ELB health would make Auto
# Scaling replace a healthy router. Do not health-gate or move the staged rule until the target
# colour's ASG explicitly carries it.
if [ "$SERVICE" = "router" ] && [ -n "${STORAGE_RULE_ARN:-}" ]; then
  storage_target=$(group_arn_of storage "$TARGET")
  storage_attached=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$NAME_PREFIX-router-$TARGET" \
    --query "contains(AutoScalingGroups[0].TargetGroupARNs, '$storage_target')" \
    --output text)
  case "$storage_attached" in
    True|true) EXTRAS="$EXTRAS rule|storage|$STORAGE_RULE_ARN" ;;
    False|false)
      echo "$SERVICE: storage target group is staged but not attached; leaving its rule unchanged"
      ;;
    *)
      echo "$SERVICE: could not determine whether storage target group is attached (got: '$storage_attached')" >&2
      exit 1
      ;;
  esac
fi

if [ "$target_arn" = "$live" ]; then
  if [ -z "$DRY_RUN" ]; then reconcile_scaling_processes; fi
  echo "$SERVICE is already on $TARGET; nothing to do" >&2
  exit 0
fi

# The target group must actually be serving before traffic moves to it. Without this the cutover is
# to a group of instances that are still booting, and the first requests of the release 503.
healthy=$(aws elbv2 describe-target-health --target-group-arn "$target_arn" \
  --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)

# A count that is not a number is not a count. `[ "" -lt 1 ]` is an error, and an error in a test
# reads as false — so an empty answer from a failed describe would sail past the guard below and
# cut over to a group nobody checked.
if ! [[ "$healthy" =~ ^[0-9]+$ ]]; then
  echo "could not read target health for $SERVICE/$TARGET (got: '$healthy')" >&2
  exit 1
fi

if [ "$healthy" -lt 1 ]; then
  echo "no healthy targets in $SERVICE/$TARGET; refusing to cut over" >&2
  exit 1
fi

echo "$SERVICE: $live -> $target_arn ($healthy healthy target(s))"

if [ -n "$DRY_RUN" ]; then
  echo "dry run; not modifying the listener"
  exit 0
fi

# The extras first, so that if anything fails it is something not yet serving that is wrong.
#
# What a browser hits is moved last. A moment of the API, search or Postgres on the new colour while
# the front door is still on the old is the harmless order — and it is not hypothetical: the first
# cutover carrying a search rule hit `AccessDenied` on `ModifyRule` because the deploy role's grant
# enumerates rule ARNs and nobody had added the new one. Traffic never moved, because this ran
# before the listener did.
for extra in $EXTRAS; do
  kind=${extra%%|*}
  rest=${extra#*|}
  extra_short=${rest%%|*}
  extra_arn=${rest#*|}

  extra_target=$(group_arn_of "$extra_short" "$TARGET")
  extra_other=$(group_arn_of "$extra_short" "$other_colour")

  case "$kind" in
    rule)
      aws elbv2 modify-rule --rule-arn "$extra_arn" \
        --actions "$(forward_action "$extra_target" "$extra_other")" >/dev/null
      ;;
    listener)
      aws elbv2 modify-listener --listener-arn "$extra_arn" \
        --default-actions "$(forward_action "$extra_target" "$extra_other")" >/dev/null
      ;;
    *)
      echo "unknown extra kind: $kind" >&2
      exit 1
      ;;
  esac
done

# The primary, last. `other_colour` is derived once above and reused, so the extras and the front
# door cannot disagree about which way round they are going.
other_arn=$([ "$other_colour" = blue ] && echo "$blue" || echo "$green")

if [ -n "$RULE_ARN" ]; then
  aws elbv2 modify-rule --rule-arn "$RULE_ARN" \
    --actions "$(forward_action "$target_arn" "$other_arn")" >/dev/null
else
  aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
    --default-actions "$(forward_action "$target_arn" "$other_arn")" >/dev/null
fi

# Read back rather than trust the call. `modify-rule` returns the rule it wrote, but reading it
# fresh is what catches a concurrent cutover that landed between the check and the write.
settled=$(current_arn)
if [ "$settled" != "$target_arn" ]; then
  echo "cutover did not stick: listener now points at $settled" >&2
  exit 1
fi

reconcile_scaling_processes

echo "$SERVICE traffic is on $TARGET; scaling drained $other_colour capacity to zero"

# The old group is no longer serving, so keeping its desired capacity is both a second set of
# background workers consuming jobs and an instance bill for the idle colour. OpenTofu deliberately
# ignores desired-capacity drift because fill and cutover own it; this is cutover's half of that
# contract. Scale only after the fresh listener read above proves traffic moved.
attempt=1
scaled=""
while [ "$attempt" -le "$ASG_SCALE_RETRIES" ]; do
  if aws autoscaling set-desired-capacity \
    --auto-scaling-group-name "$drained_asg" \
    --desired-capacity 0 >/dev/null; then
    desired=$(aws autoscaling describe-auto-scaling-groups \
      --auto-scaling-group-names "$drained_asg" \
      --query 'AutoScalingGroups[0].DesiredCapacity' \
      --output text 2>/dev/null || true)
    if [ "$desired" = "0" ]; then
      scaled=1
      break
    fi
    echo "$SERVICE: desired capacity read-back for $drained_asg was '$desired' (attempt $attempt/$ASG_SCALE_RETRIES)" >&2
  else
    echo "$SERVICE: could not scale $drained_asg to 0 (attempt $attempt/$ASG_SCALE_RETRIES)" >&2
  fi

  if [ "$attempt" -lt "$ASG_SCALE_RETRIES" ]; then sleep "$ASG_SCALE_RETRY_DELAY"; fi
  attempt=$((attempt + 1))
done

if [ -z "$scaled" ]; then
  echo "$SERVICE traffic moved to $TARGET, but drained group $drained_asg did not reach desired capacity 0" >&2
  exit 1
fi

echo "$SERVICE: scaled drained $other_colour group $drained_asg to 0"
echo "$SERVICE is on $TARGET"
