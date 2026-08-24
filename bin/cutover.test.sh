#!/usr/bin/env bash
#
# `cutover.sh` against a stubbed `aws`.
#
# The AWS calls are three describes and one modify, and what is worth testing is the decision
# between them: which colour is idle, whether it is healthy, and what happens when the answer is
# neither. A real load balancer would test the same logic more slowly and only in an account nobody
# has yet.
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
    for ((i = 1; i <= $#; i++)); do
      case "${!i}" in *TargetGroupArn=*) echo "${!i#*TargetGroupArn=}" > "$STUB_STATE" ;; esac
    done
    ;;
esac
STUB
chmod +x "$STUB_DIR/aws"

export PATH="$STUB_DIR:$PATH"
export NAME_PREFIX=sproutos
export LISTENER_ARN=arn:listener
export WEBSITE_RULE_ARN=arn:rule
export STUB_CALLS="$STUB_DIR/calls"
export STUB_STATE="$STUB_DIR/live"

# `live` is the colour the listener starts on for this case; the stub file carries it from there.
run() {
  : > "$STUB_CALLS"
  echo "$STUB_LIVE" > "$STUB_STATE"
  # Exported, not merely set. The stub is a child process, and a `STUB_HEALTHY` that never reached
  # it left the script comparing an empty string — which errors, and an error in a `[` test reads as
  # false, so every health check passed without checking anything.
  export STUB_HEALTHY
  bash "$HERE/cutover.sh" "$@" 2>&1
}

echo "cutover.sh"

# Live on blue, so the idle colour is green and nothing has to say so.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router)
check "moves to the colour that is not live" "1" "$(grep -c 'router is on green' <<<"$out")"
check "modifies the listener, not a rule" "1" "$(grep -c 'modify-listener' "$STUB_CALLS")"

STUB_LIVE="arn:green" STUB_HEALTHY=2 out=$(run router)
check "moves back the other way with the same command" "1" "$(grep -c 'router is on blue' <<<"$out")"

# The website is a rule on the listener, not the listener's default.
STUB_LIVE="arn:blue" STUB_HEALTHY=1 out=$(run website)
check "modifies the rule for the website" "1" "$(grep -c 'modify-rule' "$STUB_CALLS")"

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

# The read-back guard: if something else moved the listener between the check and the write, the
# cutover must fail loudly rather than report a success that did not happen.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 STUB_STICK=no out=$(run router); status=$?
check "reports success when the write sticks" "0" "$status"

# A dry run reports the move and sends nothing.
STUB_LIVE="arn:blue" STUB_HEALTHY=2 out=$(run router --dry-run)
check "dry run sends no mutation" "0" "$(wc -l < "$STUB_CALLS" | tr -d ' ')"
check "dry run still says what it would do" "1" "$(grep -c 'dry run' <<<"$out")"

out=$(run nonsense); status=$?
check "rejects an unknown service" "2" "$status"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
