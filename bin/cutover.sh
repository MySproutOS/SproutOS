#!/usr/bin/env bash
#
# Move one service's traffic from the colour serving it to the other.
#
# Blue/green here is two target groups per service and a listener rule that names one of them. The
# deploy fills the idle group, waits for its own health checks to pass, and then this changes one
# ARN. Rollback is this script again with no arguments — it always moves to whichever colour is not
# live, so "roll back" and "roll forward" are the same operation.
#
# Usage: cutover.sh <service> [--to blue|green] [--dry-run]
#   service   website | router
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

# The website is a listener *rule* matched on host; the router is the listener's *default* action.
# The two take different API calls, which is the only place in this script the services differ.
if [ "$SERVICE" = "website" ]; then
  : "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set}"
fi

short=$([ "$SERVICE" = "website" ] && echo web || echo router)

group_arn() {
  aws elbv2 describe-target-groups \
    --names "$NAME_PREFIX-$short-$1" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text
}

current_arn() {
  if [ "$SERVICE" = "website" ]; then
    aws elbv2 describe-rules --rule-arns "$WEBSITE_RULE_ARN" \
      --query 'Rules[0].Actions[0].TargetGroupArn' --output text
  else
    aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" \
      --query 'Listeners[0].DefaultActions[0].TargetGroupArn' --output text
  fi
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

if [ "$SERVICE" = "website" ]; then
  aws elbv2 modify-rule --rule-arn "$WEBSITE_RULE_ARN" \
    --actions "Type=forward,TargetGroupArn=$target_arn" >/dev/null
else
  aws elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
    --default-actions "Type=forward,TargetGroupArn=$target_arn" >/dev/null
fi

# Read back rather than trust the call. `modify-rule` returns the rule it wrote, but reading it
# fresh is what catches a concurrent cutover that landed between the check and the write.
settled=$(current_arn)
if [ "$settled" != "$target_arn" ]; then
  echo "cutover did not stick: listener now points at $settled" >&2
  exit 1
fi

echo "$SERVICE is on $TARGET"
