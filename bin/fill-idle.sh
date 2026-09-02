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
DESIRED="${DESIRED:-1}"
# Two minutes of boot plus the health check's own thresholds. An instance that has not answered by
# then is not slow, it is broken.
TIMEOUT_S="${TIMEOUT_S:-300}"
# Long-lived model and edge connections have a five-minute target deregistration delay. Give the
# idle fleet time to pass that AWS state before declaring its replacement stuck.
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-600}"

group_arn() {
  aws elbv2 describe-target-groups --names "$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}

for service in $SERVICES; do
  # `api` is not a service here and must not be passed as one: it has no Auto Scaling group of its
  # own. It is a second target group on the *website's* instances, which is why the health wait
  # below covers both and why the cutover moves both rules together.
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

  # Target tracking belongs only to the colour carrying traffic. In particular, NLB active-flow
  # metrics can remain non-zero for the full connection-drain window after a cutover. If alarm
  # notifications remain active on the idle group, that delayed metric can immediately recreate
  # every instance this script is trying to drain. `cutover.sh` resumes the process only after this
  # colour becomes the freshly confirmed live colour.
  aws autoscaling suspend-processes \
    --auto-scaling-group-name "$group" \
    --scaling-processes AlarmNotification

  set_capacity() {
    capacity=$1
    for attempt in $(seq 1 60); do
      if error=$(aws autoscaling set-desired-capacity \
        --auto-scaling-group-name "$group" --desired-capacity "$capacity" --honor-cooldown 2>&1); then
        return 0
      fi
      if ! grep -q 'ScalingActivityInProgress' <<<"$error"; then
        echo "$service: $error" >&2
        return 1
      fi
      if [ "$attempt" -eq 60 ]; then
        echo "$service: $group was still busy after 10 minutes" >&2
        return 1
      fi
      sleep 10
    done
  }

  # Instances read the release pointer at boot, so anything already idle is stale. Drain it to zero
  # before starting the new release. The former terminate-without-decrement sequence first replaced
  # every stale instance: a six-instance idle group opened enough control-plane pools to exhaust
  # Postgres and make authenticated dashboard requests fail. Zero-first never overlaps idle fleets.
  existing=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$group" \
    --query 'length(AutoScalingGroups[0].Instances)' --output text)
  if ! [[ "$existing" =~ ^[0-9]+$ ]]; then
    echo "$service: could not read instance count for $group (got: '$existing')" >&2
    exit 1
  fi

  if [ "$existing" -gt 0 ]; then
    echo "$service: draining $existing stale idle instance(s) before booting the release"
    set_capacity 0
    drain_deadline=$(( $(date +%s) + DRAIN_TIMEOUT_S ))
    while :; do
      remaining=$(aws autoscaling describe-auto-scaling-groups \
        --auto-scaling-group-names "$group" \
        --query 'length(AutoScalingGroups[0].Instances)' --output text)
      if [ "$remaining" = 0 ]; then break; fi
      if ! [[ "$remaining" =~ ^[0-9]+$ ]]; then
        echo "$service: could not read draining instance count (got: '$remaining')" >&2
        exit 1
      fi
      if [ "$(date +%s)" -ge "$drain_deadline" ]; then
        echo "$service: $remaining idle instance(s) still draining after ${DRAIN_TIMEOUT_S}s" >&2
        exit 1
      fi
      sleep 10
    done
  fi

  set_capacity "$DESIRED"

  # Every target group the instances serve, not just the one the rule names.
  #
  # For the website that is the apex's group *and* the API's, because both processes run on these
  # instances and the release is not up until both answer. Waiting on the website alone would
  # report a healthy release while the API was still failing its readiness probe — and the cutover
  # would then move both rules to it.
  wait_shorts=""
  if [ "$service" = "website" ]; then
    wait_shorts="api"
  else
    # The router binary is one release with several listeners. A healthy HTTP front door says
    # nothing about the model, search, database, queue, or sandbox-egress ports on the same
    # instance. Keep this list in the same configuration vocabulary as `cutover.sh`: an unset
    # endpoint is absent from this estate; a configured endpoint must be healthy before any of the
    # release moves.
    [ -n "${SEARCH_RULE_ARN:-}" ] && wait_shorts="$wait_shorts search"
    if [ -n "${STORAGE_RULE_ARN:-}" ]; then
      storage_arn=$(group_arn "$NAME_PREFIX-storage-$idle")
      storage_attached=$(aws autoscaling describe-auto-scaling-groups \
        --auto-scaling-group-names "$group" \
        --query "contains(AutoScalingGroups[0].TargetGroupARNs, '$storage_arn')" \
        --output text)
      case "$storage_attached" in
        True|true) wait_shorts="$wait_shorts storage" ;;
        False|false)
          echo "$service: storage target group is staged but not attached; skipping its health until enablement"
          ;;
        *)
          echo "$service: could not determine whether storage target group is attached (got: '$storage_attached')" >&2
          exit 1
          ;;
      esac
    fi
    [ -n "${LLM_RULE_ARN:-}" ] && wait_shorts="$wait_shorts llm"
    [ -n "${PG_LISTENER_ARN:-}" ] && wait_shorts="$wait_shorts pg"
    [ -n "${VALKEY_LISTENER_ARN:-}" ] && wait_shorts="$wait_shorts valkey"
    [ -n "${FORWARD_PROXY_LISTENER_ARN:-}" ] && wait_shorts="$wait_shorts ${TENANT_HTTPS_TARGET_GROUP_SHORT:-egress}"
    [ -n "${FORWARD_PROXY_HTTP_LISTENER_ARN:-}" ] && wait_shorts="$wait_shorts egress"
    [ -n "${TENANT_HTTP_LISTENER_ARN:-}" ] && wait_shorts="$wait_shorts edge-http"
  fi

  wait_arns="$idle_arn"
  for wait_short in $wait_shorts; do
    wait_arns="$wait_arns $(group_arn "$NAME_PREFIX-$wait_short-$idle")"
  done

  deadline=$(( $(date +%s) + TIMEOUT_S ))
  while :; do
    healthy=""
    for arn in $wait_arns; do
      count=$(aws elbv2 describe-target-health --target-group-arn "$arn" \
        --query 'length(TargetHealthDescriptions[?TargetHealth.State==`healthy`])' --output text)

      # An unreadable count is not zero and not a pass — see the same guard in `cutover.sh`.
      if ! [[ "$count" =~ ^[0-9]+$ ]]; then
        echo "$service: could not read target health (got: '$count')" >&2
        exit 1
      fi

      # The minimum across the groups: a release where one port is up and another is not is not a
      # release that is up.
      if [ -z "$healthy" ] || [ "$count" -lt "$healthy" ]; then healthy="$count"; fi
    done

    if [ "$healthy" -ge "$DESIRED" ]; then
      echo "$service: $idle has $healthy healthy target(s) in every group"
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
