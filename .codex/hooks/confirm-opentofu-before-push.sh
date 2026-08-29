#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
command=$(jq -r '.tool_input.command // empty' <<<"$input")

if ! [[ "$command" =~ (^|[\;\&\|[:space:]])git[[:space:]]+push([[:space:]]|$) ]] &&
  ! [[ "$command" =~ (^|[\;\&\|[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$) ]]; then
  exit 0
fi

if [[ "$command" =~ (^|[\;\&\|[:space:]])SPROUT_OPENTOFU_APPLIED=1([[:space:]]|$) ]]; then
  exit 0
fi

jq -n '
{
  systemMessage: "After confirming yes, retry the command with SPROUT_OPENTOFU_APPLIED=1.",
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "did you apply opentofu before git push?"
  }
}'
