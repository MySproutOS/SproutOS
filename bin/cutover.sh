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
# `website` moves two rules, not one. The apex and `api.<domain>` are different ports on the *same
# instances* from the *same release tarball*, so they are one deployment with two target groups.
# Moving them separately would be two commands that can disagree — and a disagreement means the API
# is pointed at the colour the website just drained.
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

# The website and the API are listener *rules* matched on host; the router is the listener's
# *default* action. That is the only place in this script the services differ, and it is why the
# rule ARN is required for two of the three and meaningless for the last.
# `RULE_ARN` decides the colour and is read back to confirm the move; `ALSO_MOVE` follows it
# without a vote. For the website that second rule is the API's, which has its own target groups on
# its own port but is never a different colour.
if [ "$SERVICE" = "website" ]; then
  : "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set}"
  : "${API_RULE_ARN:?API_RULE_ARN is not set}"
  RULE_ARN="$WEBSITE_RULE_ARN"
  ALSO_MOVE="$API_RULE_ARN"
  ALSO_SHORT=api
  short=web
else
  RULE_ARN=""
  ALSO_MOVE=""
  ALSO_SHORT=""
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

if [ "$target_arn" = "$live" ]; then
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

other_arn=$([ "$target_arn" = "$blue" ] && echo "$green" || echo "$blue")

# The second rule first, so that if anything fails it is the one not yet serving that is wrong.
# The website rule is what a browser hits; the API rule is what the website's own calls hit, and a
# moment of the API on the new colour while the site is still on the old is the harmless order.
if [ -n "$ALSO_MOVE" ]; then
  also_target=$(group_arn_of "$ALSO_SHORT" "$TARGET")
  also_other=$(group_arn_of "$ALSO_SHORT" "$([ "$TARGET" = blue ] && echo green || echo blue)")
  aws elbv2 modify-rule --rule-arn "$ALSO_MOVE" \
    --actions "$(forward_action "$also_target" "$also_other")" >/dev/null
fi

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

echo "$SERVICE is on $TARGET"
