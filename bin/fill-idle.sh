#!/usr/bin/env bash
#
# Start instances in the colour that is *not* serving, and wait until the load balancer agrees they
# are healthy.
#
# This is the half of a blue/green deploy that is safe to do unattended: it touches nothing carrying
# traffic. `cutover.sh` is the half that is not, and it refuses to move to a colour this has not
# made healthy.
set -euo pipefail

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${LISTENER_ARN:?LISTENER_ARN is not set}"
: "${SERVICES:?SERVICES is not set}"
DESIRED="${DESIRED:-2}"
# Two minutes of boot plus the health check's own thresholds. An instance that has not answered by
# then is not slow, it is broken.
TIMEOUT_S="${TIMEOUT_S:-300}"

group_arn() {
  aws elbv2 describe-target-groups --names "$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}

for service in $SERVICES; do
  short=$([ "$service" = "website" ] && echo web || echo router)

  if [ "$service" = "website" ]; then
    : "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set}"
    live=$(aws elbv2 describe-rules --rule-arns "$WEBSITE_RULE_ARN" \
      --query 'Rules[0].Actions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
      --output text)
  else
    live=$(aws elbv2 describe-listeners --listener-arns "$LISTENER_ARN" \
      --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
      --output text)
  fi

  blue=$(group_arn "$NAME_PREFIX-$short-blue")
  green=$(group_arn "$NAME_PREFIX-$short-green")

  # Derived from what is live, never from an argument. Being told which colour to fill is how a
  # deploy scales up the group that is already serving and then "cuts over" to itself.
  if [ "$live" = "$blue" ]; then
    idle=green idle_arn="$green"
  elif [ "$live" = "$green" ]; then
    idle=blue idle_arn="$blue"
  else
    echo "$service: the listener points at neither target group; refusing to guess" >&2
    exit 1
  fi

  group="$NAME_PREFIX-$short-$idle"
  echo "$service: filling $idle ($DESIRED instance(s))"

  # Instances read the release pointer at boot, so they come up on whatever the release job just
  # wrote. Replacing them is how a re-run picks up a new release without a launch template change.
  aws autoscaling set-desired-capacity \
    --auto-scaling-group-name "$group" --desired-capacity "$DESIRED" --honor-cooldown >/dev/null

  deadline=$(( $(date +%s) + TIMEOUT_S ))
  while :; do
    healthy=$(aws elbv2 describe-target-health --target-group-arn "$idle_arn" \
      --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)

    # An unreadable count is not zero and not a pass — see the same guard in `cutover.sh`.
    if ! [[ "$healthy" =~ ^[0-9]+$ ]]; then
      echo "$service: could not read target health (got: '$healthy')" >&2
      exit 1
    fi

    if [ "$healthy" -ge "$DESIRED" ]; then
      echo "$service: $idle has $healthy healthy target(s)"
      break
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$service: only $healthy of $DESIRED targets healthy after ${TIMEOUT_S}s" >&2
      # Left running deliberately. Scaling back to zero would destroy the instances and their
      # logs, and the reason the release did not come up is on those instances. Nothing is serving
      # from this colour, so leaving it costs only the instances until somebody looks.
      exit 1
    fi

    sleep 10
  done
done
