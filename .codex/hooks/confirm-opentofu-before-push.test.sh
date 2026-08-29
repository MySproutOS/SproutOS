#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
HOOK="$ROOT/.codex/hooks/confirm-opentofu-before-push.sh"
PROMPT='did you apply opentofu before git push?'

run_hook() {
  jq -n --arg command "$1" '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$command}}' |
    "$HOOK"
}

for command in 'git push origin main' 'git status && git push' 'gh pr merge 123 --merge'; do
  output=$(run_hook "$command")
  jq -e --arg prompt "$PROMPT" '
    .hookSpecificOutput.hookEventName == "PreToolUse" and
    .hookSpecificOutput.permissionDecision == "deny" and
    .hookSpecificOutput.permissionDecisionReason == $prompt
  ' <<<"$output" >/dev/null
done

test -z "$(run_hook 'git status')"
test -z "$(run_hook 'SPROUT_OPENTOFU_APPLIED=1 git push origin main')"
test -z "$(run_hook 'git fetch && SPROUT_OPENTOFU_APPLIED=1 gh pr merge 123 --merge')"

echo 'Codex OpenTofu confirmation hook acceptance passed'
