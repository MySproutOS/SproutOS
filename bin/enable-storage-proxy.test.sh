#!/usr/bin/env bash
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
    echo "  FAIL: $name (expected '$expected', got '$actual')" >&2
    failures=$((failures + 1))
  fi
}

cat > "$STUB_DIR/aws" <<'STUB'
#!/usr/bin/env bash
case "$2" in
  describe-target-groups)
    case "$*" in
      *router-blue*) echo arn:router-blue ;;
      *router-green*) echo arn:router-green ;;
      *storage-blue*) echo arn:storage-blue ;;
      *storage-green*) echo arn:storage-green ;;
    esac
    ;;
  describe-listeners) echo "${STUB_LIVE:-arn:router-blue}" ;;
  describe-auto-scaling-groups)
    case "$*" in
      *router-blue*) echo "${STUB_BLUE_ATTACHED:-True}" ;;
      *router-green*) echo "${STUB_GREEN_ATTACHED:-True}" ;;
    esac
    ;;
  describe-target-health) echo "${STUB_HEALTHY:-1}" ;;
  modify-rule)
    echo "$*" >> "$STUB_CALLS"
    live=$(grep -o '"TargetGroupArn":"[^"]*","Weight":100' <<<"$*" | head -1 \
      | sed 's/"TargetGroupArn":"//; s/","Weight":100//')
    echo "$live" > "$STUB_RULE"
    ;;
  describe-rules) cat "$STUB_RULE" ;;
esac
STUB
chmod +x "$STUB_DIR/aws"

export PATH="$STUB_DIR:$PATH"
export NAME_PREFIX=sproutos LISTENER_ARN=arn:listener STORAGE_RULE_ARN=arn:storage-rule
export STUB_CALLS="$STUB_DIR/calls" STUB_RULE="$STUB_DIR/rule"

run() {
  : > "$STUB_CALLS"
  echo arn:storage-green > "$STUB_RULE"
  export STUB_LIVE STUB_BLUE_ATTACHED STUB_GREEN_ATTACHED STUB_HEALTHY
  bash "$HERE/enable-storage-proxy.sh" 2>&1
}

echo "enable-storage-proxy.sh"
STUB_LIVE=arn:router-blue STUB_BLUE_ATTACHED=True STUB_GREEN_ATTACHED=True STUB_HEALTHY=1 out=$(run); status=$?
check "enables against a healthy live colour" 0 "$status"
check "moves the storage rule to the router colour" 1 \
  "$(grep -c 'arn:storage-blue.*Weight.:100' "$STUB_CALLS")"
check "reports the reconciled colour" 1 "$(grep -c 'enabled on blue' <<<"$out")"

STUB_LIVE=arn:router-blue STUB_BLUE_ATTACHED=False STUB_GREEN_ATTACHED=True STUB_HEALTHY=1 out=$(run); status=$?
check "refuses before OpenTofu attaches the live target group" 1 "$status"
check "does not move an unattached target" 0 "$(wc -l < "$STUB_CALLS" | tr -d ' ')"

STUB_LIVE=arn:router-blue STUB_BLUE_ATTACHED=True STUB_GREEN_ATTACHED=False STUB_HEALTHY=1 out=$(run); status=$?
check "refuses before OpenTofu attaches the idle target group" 1 "$status"
check "does not enable a one-colour rollout" 0 "$(wc -l < "$STUB_CALLS" | tr -d ' ')"

STUB_LIVE=arn:router-green STUB_BLUE_ATTACHED=True STUB_GREEN_ATTACHED=True STUB_HEALTHY=0 out=$(run); status=$?
check "refuses an attached but unhealthy target" 1 "$status"
check "does not move an unhealthy target" 0 "$(wc -l < "$STUB_CALLS" | tr -d ' ')"

STUB_LIVE=arn:unknown STUB_BLUE_ATTACHED=True STUB_GREEN_ATTACHED=True STUB_HEALTHY=1 out=$(run); status=$?
check "refuses an unknown router colour" 1 "$status"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
