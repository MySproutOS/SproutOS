#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=bin/lib/localstack-kms.sh
source "$repo_root/bin/lib/localstack-kms.sh"

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/sproutos-localstack-kms-test.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
export LOCALSTACK_KMS_RETRY_DELAY_SECONDS=0

fail() {
  echo "$*" >&2
  exit 1
}

# An ordinary repeat must read the existing alias and create nothing.
aws_local() {
  if [[ "$1 $2" == "kms describe-key" ]]; then return 0; fi
  fail "idempotent call unexpectedly mutated KMS: $*"
}
ensure_localstack_kms_alias alias/sproutos-dev "SproutOS dev envelope key" >/dev/null

# A restored alias may be invisible for one read. The bounded retry must find it without creating
# a second key, which is the exact LocalStack restart race this test was added for.
transient_reads=0
aws_local() {
  if [[ "$1 $2" == "kms describe-key" ]]; then
    transient_reads=$((transient_reads + 1))
    [[ "$transient_reads" -ge 2 ]]
    return
  fi
  fail "transient read unexpectedly mutated KMS: $*"
}
ensure_localstack_kms_alias alias/sproutos-dev "SproutOS dev envelope key" >/dev/null
[[ "$transient_reads" == 2 ]] || fail "expected two DescribeKey calls, got $transient_reads"

# A CreateAlias error is only reconciled when the alias really exists. Authentication failures or
# other provider errors must still fail the bootstrap instead of being mislabeled as a race.
aws_local() {
  case "$1 $2" in
    "kms describe-key") return 1 ;;
    "kms create-key") echo key-failed ;;
    "kms create-alias") echo AccessDenied >&2; return 254 ;;
    *) fail "unexpected failed-create AWS call: $*" ;;
  esac
}
if ensure_localstack_kms_alias alias/sproutos-dev "SproutOS dev envelope key" \
  >"$test_dir/failed.out" 2>"$test_dir/failed.err"; then
  fail "a missing alias hid the CreateAlias failure"
fi
grep -q AccessDenied "$test_dir/failed.err"

# Force two bootstraps to miss every pre-create read. One CreateAlias wins atomically; the loser
# receives AlreadyExists, confirms the alias, and also succeeds. This makes the race deterministic
# instead of relying on process scheduling.
race_dir="$test_dir/race"
mkdir "$race_dir"
run_racer() (
  local actor=$1
  local reads=0
  aws_local() {
    case "$1 $2" in
      "kms describe-key")
        reads=$((reads + 1))
        if [[ "$reads" -le 3 ]]; then return 1; fi
        [[ -d "$race_dir/alias" ]]
        ;;
      "kms create-key")
        printf '%s\n' "$actor" >> "$race_dir/keys"
        printf 'key-%s\n' "$actor"
        ;;
      "kms create-alias")
        printf '%s\n' "$actor" >> "$race_dir/alias-attempts"
        if mkdir "$race_dir/alias" 2>/dev/null; then return 0; fi
        echo "AlreadyExistsException" >&2
        return 254
        ;;
      *) fail "unexpected fake AWS call: $*" ;;
    esac
  }
  ensure_localstack_kms_alias alias/sproutos-dev "SproutOS dev envelope key" \
    >"$race_dir/$actor.out"
)

run_racer first &
first_pid=$!
run_racer second &
second_pid=$!
wait "$first_pid"
wait "$second_pid"

[[ -d "$race_dir/alias" ]] || fail "concurrent bootstraps did not create the alias"
[[ $(wc -l < "$race_dir/keys" | tr -d ' ') == 2 ]] || fail "both racers did not reach CreateKey"
[[ $(wc -l < "$race_dir/alias-attempts" | tr -d ' ') == 2 ]] || \
  fail "both racers did not exercise CreateAlias"
[[ $(grep -l 'created KMS key' "$race_dir/first.out" "$race_dir/second.out" | wc -l | tr -d ' ') == 1 ]] || \
  fail "exactly one racer should create the alias"
[[ $(grep -l 'was created concurrently' "$race_dir/first.out" "$race_dir/second.out" | wc -l | tr -d ' ') == 1 ]] || \
  fail "exactly one racer should reconcile the concurrent alias"

echo "LocalStack KMS bootstrap is repeatable, eventually consistent, and race-safe"
