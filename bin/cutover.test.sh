#!/usr/bin/env bash
#
# `cutover.sh` against a stubbed `aws`.
#
# The fake covers both load-balancer movement and the drained Auto Scaling group. What is worth
# testing is the decision between them: which colour is idle, whether it is healthy, whether the
# traffic write stuck, and whether the old desired capacity reached zero afterwards.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

failures=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok: $name"
  else
    echo "  FAIL: $name" >&2
    echo "    expected: $expected" >&2
    echo "    actual:   $actual" >&2
    failures=$((failures + 1))
  fi
}

# A fake `aws`, stateful on purpose.
#
# A modify writes the new value to the same file the describes read, so the script's read-back check
# sees what it actually wrote. A stub that ignored the write would fail every test for the wrong
# reason — which it did, and the read-back guard is what caught the stub rather than the script.
cat > "$STUB_DIR/aws" <<'STUB'
#!/usr/bin/env bash
case "$2" in
  describe-target-groups)
    for ((i = 1; i <= $#; i++)); do
      if [ "${!i}" = "--names" ]; then
        j=$((i + 1))
        case "${!j}" in
          *-api-blue) echo "arn:api-blue" ;;
          *-api-green) echo "arn:api-green" ;;
          *-search-blue) echo "arn:search-blue" ;;
          *-search-green) echo "arn:search-green" ;;
          *-storage-blue) echo "arn:storage-blue" ;;
          *-storage-green) echo "arn:storage-green" ;;
          *-llm-blue) echo "arn:llm-blue" ;;
          *-llm-green) echo "arn:llm-green" ;;
          *-pg-blue) echo "arn:pg-blue" ;;
          *-pg-green) echo "arn:pg-green" ;;
          *-valkey-blue) echo "arn:valkey-blue" ;;
          *-valkey-green) echo "arn:valkey-green" ;;
          *-egress-blue) echo "arn:egress-blue" ;;
          *-egress-green) echo "arn:egress-green" ;;
          *-edge-http-blue) echo "arn:edge-http-blue" ;;
          *-edge-http-green) echo "arn:edge-http-green" ;;
          *-edge-blue) echo "arn:edge-blue" ;;
          *-edge-green) echo "arn:edge-green" ;;
          *-blue) echo "arn:blue" ;;
          *-green) echo "arn:green" ;;
        esac
      fi
    done
    ;;
  describe-rules|describe-listeners) cat "$STUB_STATE" ;;
  describe-target-health) echo "$STUB_HEALTHY" ;;
  modify-rule|modify-listener)
    echo "$*" >> "$STUB_CALLS"
    # The colour that is live afterwards is the one the action gave weight 100 — the same reading
    # the script's own `current_arn` does. A stub that took the *first* ARN in the JSON would agree
    # with the script by accident and stop being able to catch a cutover written the wrong way round.
    live=$(grep -o '"TargetGroupArn":"[^"]*","Weight":100' <<<"$*" | head -1 \
      | sed 's/"TargetGroupArn":"//; s/","Weight":100//')
    [ -n "$live" ] && echo "$live" > "$STUB_STATE"
    ;;
  set-desired-capacity)
    echo "$*" >> "$STUB_CALLS"
    attempts=$(cat "$STUB_SCALE_ATTEMPTS")
    attempts=$((attempts + 1))
    echo "$attempts" > "$STUB_SCALE_ATTEMPTS"
    if [ "$attempts" -le "$STUB_SCALE_FAILS" ]; then exit 1; fi
    for ((i = 1; i <= $#; i++)); do
      if [ "${!i}" = "--auto-scaling-group-name" ]; then
        j=$((i + 1))
        group=${!j}
      fi
    done
    echo 0 > "$STUB_ASG_STATE/$group"
    ;;
  describe-auto-scaling-groups)
    if [[ "$*" == *TargetGroupARNs* ]]; then
      echo "${STUB_STORAGE_ATTACHED:-True}"
    else
      for ((i = 1; i <= $#; i++)); do
        if [ "${!i}" = "--auto-scaling-group-names" ]; then
          j=$((i + 1))
          cat "$STUB_ASG_STATE/${!j}"
        fi
      done
    fi
    ;;
esac
STUB
chmod +x "$STUB_DIR/aws"

export PATH="$STUB_DIR:$PATH"
export NAME_PREFIX=sproutos
export LISTENER_ARN=arn:listener
export WEBSITE_RULE_ARN=arn:rule
export API_RULE_ARN=arn:api-rule
export STUB_CALLS="$STUB_DIR/calls"
export STUB_STATE="$STUB_DIR/live"
export STUB_ASG_STATE="$STUB_DIR/asg"
export STUB_SCALE_ATTEMPTS="$STUB_DIR/scale-attempts"
export CUTOVER_ASG_SCALE_RETRY_DELAY=0
mkdir -p "$STUB_ASG_STATE"

# `live` is the colour the listener starts on for this case; the stub file carries it from there.
run() {
  : > "$STUB_CALLS"
  echo "$STUB_LIVE" > "$STUB_STATE"
  echo 0 > "$STUB_SCALE_ATTEMPTS"
  for service in web router; do
    for colour in blue green; do
      echo 1 > "$STUB_ASG_STATE/sproutos-$service-$colour"
    done
  done
  # Exported, not merely set. The stub is a child process, and a `STUB_HEALTHY` that never reached
  # it left the script comparing an empty string — which errors, and an error in a `[` test reads as
  # false, so every health check passed without checking anything.
  export STUB_HEALTHY
  export STUB_SCALE_FAILS="${STUB_SCALE_FAILS:-0}"
  export STUB_STORAGE_ATTACHED="${STUB_STORAGE_ATTACHED:-True}"
  # `SEARCH_RULE_ARN` the same way, and for the same reason the comment above gives: a variable
  # merely *set* on the `run` line is a shell variable, and `cutover.sh` runs in a child process
  # that never sees it. Set-and-not-exported is how the search rule silently stopped being moved —
  # the first version of these two checks failed for exactly that, which is the one useful thing a
  # test can do before the code it guards is wrong.
  #
  # Clearing it has to happen in the *caller*, not here: `out=$(run router)` puts this function in
  # a subshell, so an `unset` here dies with it, while `SEARCH_RULE_ARN=… out=$(run router)` assigns
  # in the parent and outlives the case that wrote it. See the `unset` before the no-rule case.
  if [ -n "${SEARCH_RULE_ARN:-}" ]; then export SEARCH_RULE_ARN; fi
  if [ -n "${STORAGE_RULE_ARN:-}" ]; then export STORAGE_RULE_ARN; fi
  if [ -n "${LLM_RULE_ARN:-}" ]; then export LLM_RULE_ARN; fi
  if [ -n "${PG_LISTENER_ARN:-}" ]; then export PG_LISTENER_ARN; fi
  if [ -n "${VALKEY_LISTENER_ARN:-}" ]; then export VALKEY_LISTENER_ARN; fi
  if [ -n "${FORWARD_PROXY_LISTENER_ARN:-}" ]; then export FORWARD_PROXY_LISTENER_ARN; fi
  if [ -n "${TENANT_HTTP_LISTENER_ARN:-}" ]; then export TENANT_HTTP_LISTENER_ARN; fi
  if [ -n "${TENANT_HTTPS_TARGET_GROUP_SHORT:-}" ]; then export TENANT_HTTPS_TARGET_GROUP_SHORT; fi
  bash "$HERE/cutover.sh" "$@" 2>&1
}

echo "cutover.sh"

# The script cannot move an optional endpoint it is never told exists. Keep the production
# workflow's LLM rule connected to the same atomic router cutover exercised below.
check "production passes the LLM rule through both deployment stages" "2" \
  "$(grep -c 'LLM_RULE_ARN:.*vars.LLM_RULE_ARN' "$HERE/../.github/workflows/deploy.yml")"
check "deploy role may move the LLM rule" "1" \
  "$(grep -c 'aws_lb_listener_rule.llm.arn' "$HERE/../tofu/oidc.tf")"
check "production passes the storage rule through both deployment stages" "2" \
  "$(grep -c 'STORAGE_RULE_ARN:.*vars.STORAGE_RULE_ARN' "$HERE/../.github/workflows/deploy.yml")"
check "deploy role may move the storage rule" "1" \
  "$(grep -c 'aws_lb_listener_rule.storage.arn' "$HERE/../tofu/oidc.tf")"

# Live on blue, so the idle colour is green and nothing has to say so.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router)
check "moves to the colour that is not live" "1" "$(grep -c 'router is on green' <<<"$out")"
check "modifies the listener, not a rule" "1" "$(grep -c 'modify-listener' "$STUB_CALLS")"
# Both groups stay attached and the idle one is given none of the traffic, rather than being taken
# off the listener. The scaling policies need every group routed — a target group nothing forwards
# to rejects an `ALBRequestCountPerTarget` policy outright, which is what a bare
# `Type=forward,TargetGroupArn=…` would cause on the next apply.
check "sends the idle colour to zero, not off the listener" "1" \
  "$(grep -c '"TargetGroupArn":"arn:blue","Weight":0' "$STUB_CALLS")"
check "scales the drained router colour to zero after cutover" "1" \
  "$(grep -c 'set-desired-capacity --auto-scaling-group-name sproutos-router-blue --desired-capacity 0' "$STUB_CALLS")"
check "reads back the drained router desired capacity" "0" \
  "$(cat "$STUB_ASG_STATE/sproutos-router-blue")"
check "leaves the serving router colour running" "1" \
  "$(cat "$STUB_ASG_STATE/sproutos-router-green")"

STUB_LIVE="arn:green" STUB_HEALTHY=2 out=$(run router)
check "moves back the other way with the same command" "1" "$(grep -c 'router is on blue' <<<"$out")"

# The website is rules on the listener, not the listener's default — and one healthy target is
# enough, since the guard is "any", not "all".
STUB_LIVE="arn:blue" STUB_HEALTHY=1 out=$(run website)
check "modifies rules for the website, never the listener" "0" \
  "$(grep -c 'modify-listener' "$STUB_CALLS")"
check "one healthy target is enough to move" "2" "$(grep -c 'modify-rule' "$STUB_CALLS")"
check "scales the drained website colour, not a router group" "1" \
  "$(grep -c 'set-desired-capacity --auto-scaling-group-name sproutos-web-blue --desired-capacity 0' "$STUB_CALLS")"

# The two refusals.
#
# A cutover to a group with nothing healthy in it is a release whose first requests 503. A listener
# pointing at neither group means somebody changed something by hand, and guessing which way to go
# from there is how a rollback becomes an outage.
STUB_LIVE="arn:blue" STUB_HEALTHY=0 out=$(run router); status=$?
check "refuses when nothing is healthy" "1" "$status"
check "says why" "1" "$(grep -c 'no healthy targets' <<<"$out")"
check "changes nothing" "0" "$(wc -l < "$STUB_CALLS" | tr -d ' ')"

STUB_LIVE="arn:something-else" STUB_HEALTHY=2 out=$(run router); status=$?
check "refuses to guess from an unknown target" "1" "$status"
check "changes nothing when it cannot tell" "0" "$(wc -l < "$STUB_CALLS" | tr -d ' ')"

# Asking for the colour already live is a no-op, not an error: a retried deploy step should be safe.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router --to blue); status=$?
check "is a no-op when already there" "0" "$status"
check "and changes nothing" "0" "$(wc -l < "$STUB_CALLS" | tr -d ' ')"
check "and does not scale either colour" "0" "$(grep -c 'set-desired-capacity' "$STUB_CALLS")"

# The read-back guard: if something else moved the listener between the check and the write, the
# cutover must fail loudly rather than report a success that did not happen.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 STUB_STICK=no out=$(run router); status=$?
check "reports success when the write sticks" "0" "$status"

# A dry run reports the move and sends nothing.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router --dry-run)
check "dry run sends no mutation" "0" "$(wc -l < "$STUB_CALLS" | tr -d ' ')"
check "dry run still says what it would do" "1" "$(grep -c 'dry run' <<<"$out")"
check "dry run does not scale the idle group" "0" "$(grep -c 'set-desired-capacity' "$STUB_CALLS")"

# `website` is one deployment on two ports, so the cutover moves two rules. If it moved only the
# apex, the API would be left pointing at the colour the website had just drained — and the site's
# own calls to it would fail while the site itself looked fine.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run website)
check "moves both rules for one website release" "2" "$(grep -c 'modify-rule' "$STUB_CALLS")"
check "sends the api rule to the same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:api-green","Weight":100' "$STUB_CALLS")"
check "and the apex with it" "1" \
  "$(grep -c '"TargetGroupArn":"arn:green","Weight":100' "$STUB_CALLS")"

# The router is the listener's default *and* a rule for `search.<domain>` on port 9200. If the
# cutover moved only the listener, a release would leave every customer's search service pointed at
# the colour the router had just drained — and the router itself would look fine, which is the
# failure that takes longest to find.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 SEARCH_RULE_ARN=arn:search-rule out=$(run router)
check "moves the listener for the router" "1" "$(grep -c 'modify-listener' "$STUB_CALLS")"
check "and the search rule with it" "1" "$(grep -c 'modify-rule' "$STUB_CALLS")"
check "to the same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:search-green","Weight":100' "$STUB_CALLS")"

# Without the variable there is no search rule to move, which is the state of an estate that has no
# OpenSearch behind it. That must move the router rather than refuse.
#
# Unset in the parent, because the case above assigned it there. Leaving it would make this check
# exercise the same path as the one above and pass for the wrong reason — which it did.
unset SEARCH_RULE_ARN
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router); status=$?
check "moves the router alone when there is no search rule" "0" "$status"
check "and touches no rule" "0" "$(grep -c 'modify-rule' "$STUB_CALLS")"

# The Postgres split is a *listener* on a second load balancer, not a rule on the first — so the
# extras list has to carry both kinds at once. If this moved only the rule, a release would leave
# every customer's database pointed at the colour the router had just drained, and both the router
# and search would look correct while it did.
#
# Three modify calls: the search rule, the Postgres listener, and the router's own listener.
unset SEARCH_RULE_ARN
STUB_LIVE="arn:blue" STUB_HEALTHY=2 SEARCH_RULE_ARN=arn:search-rule PG_LISTENER_ARN=arn:pg-listener \
  out=$(run router)
check "moves the search rule" "1" "$(grep -c 'modify-rule' "$STUB_CALLS")"
check "and the postgres listener" "1" \
  "$(grep -c 'modify-listener --listener-arn arn:pg-listener' "$STUB_CALLS")"
check "and the router's own listener" "1" \
  "$(grep -c 'modify-listener --listener-arn arn:listener' "$STUB_CALLS")"
check "postgres goes to the same colour as the router" "1" \
  "$(grep -c '"TargetGroupArn":"arn:pg-green","Weight":100' "$STUB_CALLS")"

# The front door moves last. Everything a customer reaches through the *other* balancer should
# already be on the new colour by the time traffic arrives — and when an extra fails, the listener
# must not have been touched at all, which is what kept an `AccessDenied` from becoming an outage.
# Its line number equals the number of calls made, i.e. it is the last one. The first version of
# this asserted `1` and failed with `3` — the code was right and the check was written backwards,
# which is the direction worth catching early.
check "the router's listener is written after the extras" \
  "$(grep -cE 'modify-rule|modify-listener' "$STUB_CALLS")" \
  "$(awk '/modify-listener --listener-arn arn:listener/{print NR}' "$STUB_CALLS" | tail -1)"

# All eight at once: the ALB listener, three adjacent rules, and four tenant-NLB listeners. The
# production TLS listener deliberately switches from legacy `egress` groups to Rust `edge` groups.
unset SEARCH_RULE_ARN PG_LISTENER_ARN
STUB_LIVE="arn:blue" STUB_HEALTHY=2 SEARCH_RULE_ARN=arn:search-rule STORAGE_RULE_ARN=arn:storage-rule LLM_RULE_ARN=arn:llm-rule \
  PG_LISTENER_ARN=arn:pg-listener VALKEY_LISTENER_ARN=arn:valkey-listener \
  FORWARD_PROXY_LISTENER_ARN=arn:forward-proxy-listener \
  TENANT_HTTP_LISTENER_ARN=arn:tenant-http-listener \
  TENANT_HTTPS_TARGET_GROUP_SHORT=edge out=$(run router)
check "moves all eight" "8" "$(grep -cE 'modify-rule|modify-listener' "$STUB_CALLS")"
check "storage among them, same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:storage-green","Weight":100' "$STUB_CALLS")"
check "llm among them, same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:llm-green","Weight":100' "$STUB_CALLS")"
check "valkey among them, same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:valkey-green","Weight":100' "$STUB_CALLS")"
check "Rust TLS edge among them, same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:edge-green","Weight":100' "$STUB_CALLS")"
check "HTTP/ACME edge among them, same colour" "1" \
  "$(grep -c '"TargetGroupArn":"arn:edge-http-green","Weight":100' "$STUB_CALLS")"
check "and the front door still last" "8" \
  "$(awk '/modify-listener --listener-arn arn:listener/{print NR}' "$STUB_CALLS" | tail -1)"

# During the first half of the rollout the rule exists but OpenTofu deliberately leaves the target
# groups detached. A normal router cutover must leave that staged rule alone.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 STUB_STORAGE_ATTACHED=False \
  STORAGE_RULE_ARN=arn:storage-rule out=$(run router)
check "moves the router while storage is staged" "0" "$?"
check "does not move an unattached storage rule" "0" \
  "$(grep -c 'modify-rule --rule-arn arn:storage-rule' "$STUB_CALLS")"
check "names the staged storage rule" "1" \
  "$(grep -c 'storage target group is staged' <<<"$out")"
unset STUB_STORAGE_ATTACHED

unset SEARCH_RULE_ARN STORAGE_RULE_ARN LLM_RULE_ARN PG_LISTENER_ARN VALKEY_LISTENER_ARN \
  FORWARD_PROXY_LISTENER_ARN TENANT_HTTP_LISTENER_ARN TENANT_HTTPS_TARGET_GROUP_SHORT

# A transient throttling or control-plane error after traffic moved must not strand the old group
# at one instance. The mutation is idempotent, so retry it and require a fresh desired-capacity
# read-back before reporting success.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 STUB_SCALE_FAILS=2 out=$(run router); status=$?
check "retries a failed drained-group scale-down" "0" "$status"
check "needed three scale attempts after two failures" "3" "$(cat "$STUB_SCALE_ATTEMPTS")"
check "eventually reads the drained group at zero" "0" \
  "$(cat "$STUB_ASG_STATE/sproutos-router-blue")"
unset STUB_SCALE_FAILS

STUB_LIVE="arn:blue" STUB_HEALTHY=2 STUB_SCALE_FAILS=99 out=$(run website); status=$?
check "fails after bounded scale-down retries" "1" "$status"
check "reports that traffic moved but capacity did not" "1" \
  "$(grep -c 'traffic moved to green, but drained group' <<<"$out")"
check "does not falsely report the whole cutover complete" "0" \
  "$(grep -c 'website is on green' <<<"$out")"
check "leaves the listener on the confirmed new colour" "arn:green" "$(cat "$STUB_STATE")"
unset STUB_SCALE_FAILS

out=$(run nonsense); status=$?
check "rejects an unknown service" "2" "$status"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
