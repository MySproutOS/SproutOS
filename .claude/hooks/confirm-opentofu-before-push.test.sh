#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
HOOK="$ROOT/.claude/hooks/confirm-opentofu-before-push.sh"
PROMPT='did you apply opentofu before git push?'

assert_asks() {
  local command=$1 output
  output=$(jq -n --arg command "$command" '{tool_input:{command:$command}}' | "$HOOK")
  jq -e --arg prompt "$PROMPT" '
    .hookSpecificOutput.hookEventName == "PreToolUse" and
    .hookSpecificOutput.permissionDecision == "ask" and
    .hookSpecificOutput.permissionDecisionReason == $prompt
  ' <<<"$output" >/dev/null
}

assert_silent() {
  local command=$1 output
  output=$(jq -n --arg command "$command" '{tool_input:{command:$command}}' | "$HOOK")
  test -z "$output"
}

assert_asks 'git push origin main'
assert_asks 'git status && git push'
assert_asks 'gh pr merge 123 --merge'
assert_asks 'git fetch origin && gh pr merge --squash 123'
assert_silent 'git status'
assert_silent 'gh pr view 123'

echo 'OpenTofu confirmation hook acceptance passed'
