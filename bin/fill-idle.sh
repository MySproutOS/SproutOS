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

  # Replace whatever is already there, then scale.
  #
  # Instances read the release pointer *at boot*, so an instance that is already running is running
  # whatever the pointer said when it started. `set-desired-capacity` alone is therefore a no-op
  # when the idle group is already at the requested size — and a silent one: the group reports the
  # right count, the targets report healthy, the deploy reports success, and the release that was
  # just built is nowhere.
  #
  # That is not hypothetical. Both colours were found serving releases two and three deploys behind
  # the pointer, which is why a favicon committed hours earlier never appeared on the site while
  # every deploy since had gone green.
  #
  # Terminating without decrementing makes the group launch replacements, which read the pointer the
  # release job has just written. This is the idle colour, so nothing it does is visible to anyone.
  existing=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$group" \
    --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
    --output text)

  for instance in $existing; do
    echo "$service: replacing $instance so it boots the new release"
    aws autoscaling terminate-instance-in-auto-scaling-group \
      --instance-id "$instance" --no-should-decrement-desired-capacity >/dev/null
  done

  # Let the terminations register before asking for a capacity change, or the request collides with
  # the scaling activity they start — the `ScalingActivityInProgress` the retry below handles.
  [ -z "$existing" ] || sleep 15

  # Skipped entirely when the group is already the size we want.
  #
  # This is the common case — `DESIRED` is 1 and the idle group holds 1 — and the call is a no-op
  # that can only fail: the terminations above leave the group replacing an instance, and
  # `SetDesiredCapacity` is rejected with `ScalingActivityInProgress` for as long as that takes. The
  # retry loop below then burns five minutes and fails the deploy, having asked for a change that
  # was never needed.
  #
  # That is not hypothetical either: the router's replacement outlasted the window and failed a
  # release whose website half had already gone healthy. The termination is what boots the new
  # release; the capacity call only matters when the size is actually changing.
  current=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$group" \
    --query 'AutoScalingGroups[0].DesiredCapacity' --output text)

  if [ "$current" = "$DESIRED" ]; then
    echo "$service: $group is already at $DESIRED; the replacement above is the whole change"
  else

  #
  # Retried, because `ScalingActivityInProgress` is a state and not an error. An Auto Scaling group
  # replacing an instance — including one this deploy's previous attempt left behind — rejects
  # `SetDesiredCapacity` outright, and treating that as fatal fails a release for a reason that
  # resolves itself in under a minute. Any other error still fails immediately.
  for attempt in $(seq 1 30); do
    if error=$(aws autoscaling set-desired-capacity \
      --auto-scaling-group-name "$group" --desired-capacity "$DESIRED" --honor-cooldown 2>&1); then
      break
    fi

    if ! grep -q 'ScalingActivityInProgress' <<<"$error"; then
      echo "$service: $error" >&2
      exit 1
    fi

    if [ "$attempt" -eq 30 ]; then
      echo "$service: $group was still busy after 5 minutes" >&2
      exit 1
    fi

    sleep 10
  done
  fi

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
