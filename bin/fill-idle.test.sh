#!/usr/bin/env bash
#
# `fill-idle.sh` against a stubbed `aws`.
#
# The important contract is wider than the router's primary health check: one router process owns
# every public and tenant listener, so the idle release is not ready until every configured target
# group is healthy.
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

cat > "$STUB_DIR/aws" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "elbv2 describe-target-groups")
    for ((i = 1; i <= $#; i++)); do
      if [ "${!i}" = "--names" ]; then
        j=$((i + 1))
        name=${!j}
        echo "arn:${name#sproutos-}"
      fi
    done
    ;;
  "elbv2 describe-listeners")
    echo "arn:router-blue"
    ;;
  "elbv2 describe-rules")
    echo "arn:web-blue"
    ;;
  "elbv2 describe-target-health")
    for ((i = 1; i <= $#; i++)); do
      if [ "${!i}" = "--target-group-arn" ]; then
        j=$((i + 1))
        arn=${!j}
      fi
    done
    echo "$arn" >> "$STUB_HEALTH_CALLS"
    if [ "$arn" = "${STUB_UNHEALTHY_ARN:-}" ]; then echo 0; else echo 1; fi
    ;;
  "autoscaling describe-auto-scaling-groups")
    if [[ "$*" == *DesiredCapacity* ]]; then echo 1; fi
    ;;
  "autoscaling set-desired-capacity"|"autoscaling terminate-instance-in-auto-scaling-group")
    echo "$*" >> "$STUB_MUTATIONS"
    ;;
esac
STUB
chmod +x "$STUB_DIR/aws"

export PATH="$STUB_DIR:$PATH"
export NAME_PREFIX=sproutos
export LISTENER_ARN=arn:listener
export WEBSITE_RULE_ARN=arn:website-rule
export DESIRED=1
export TIMEOUT_S=0
export STUB_HEALTH_CALLS="$STUB_DIR/health-calls"
export STUB_MUTATIONS="$STUB_DIR/mutations"

run() {
  : > "$STUB_HEALTH_CALLS"
  : > "$STUB_MUTATIONS"
  bash "$HERE/fill-idle.sh" 2>&1
}

echo "fill-idle.sh"

export SERVICES=router
export SEARCH_RULE_ARN=arn:search-rule
export LLM_RULE_ARN=arn:llm-rule
export PG_LISTENER_ARN=arn:pg-listener
export VALKEY_LISTENER_ARN=arn:valkey-listener
export FORWARD_PROXY_LISTENER_ARN=arn:egress-listener

out=$(run); status=$?
check "accepts a router release healthy on every configured port" "0" "$status"
check "checks all six router target groups" "6" "$(wc -l < "$STUB_HEALTH_CALLS" | tr -d ' ')"
for short in router search llm pg valkey egress; do
  check "checks $short on the idle colour" "1" \
    "$(grep -c "^arn:$short-green$" "$STUB_HEALTH_CALLS")"
done
check "reports that every group passed" "1" "$(grep -c 'healthy target(s) in every group' <<<"$out")"

# The primary router port remains healthy. The LLM port alone is down, which is the production
# failure this gate must stop before cutover rather than discover from a hanging agent turn.
export STUB_UNHEALTHY_ARN=arn:llm-green
out=$(run); status=$?
check "refuses when one configured router port is unhealthy" "1" "$status"
check "reports the minimum health across the groups" "1" \
  "$(grep -c 'only 0 of 1 targets healthy' <<<"$out")"
check "still inspected every group before refusing" "6" \
  "$(wc -l < "$STUB_HEALTH_CALLS" | tr -d ' ')"
unset STUB_UNHEALTHY_ARN

# Optional means absent from this estate, not silently ignored after it was configured.
unset SEARCH_RULE_ARN LLM_RULE_ARN PG_LISTENER_ARN VALKEY_LISTENER_ARN \
  FORWARD_PROXY_LISTENER_ARN
out=$(run); status=$?
check "allows an estate with only the router target group" "0" "$status"
check "checks only the primary group when no split is configured" "1" \
  "$(wc -l < "$STUB_HEALTH_CALLS" | tr -d ' ')"
check "does not invent an optional target group" "1" \
  "$(grep -c '^arn:router-green$' "$STUB_HEALTH_CALLS")"

# Preserve the existing website contract: the API is part of the release even though it has no
# Auto Scaling group of its own.
export SERVICES=website
out=$(run); status=$?
check "accepts a website whose web and API ports are healthy" "0" "$status"
check "checks the website and API target groups" "2" \
  "$(wc -l < "$STUB_HEALTH_CALLS" | tr -d ' ')"
check "checks web on the idle colour" "1" "$(grep -c '^arn:web-green$' "$STUB_HEALTH_CALLS")"
check "checks api on the idle colour" "1" "$(grep -c '^arn:api-green$' "$STUB_HEALTH_CALLS")"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
