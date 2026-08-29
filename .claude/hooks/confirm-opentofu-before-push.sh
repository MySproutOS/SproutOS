#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
command=$(jq -r '.tool_input.command // empty' <<<"$input")

if ! [[ "$command" =~ (^|[\;\&\|[:space:]])git[[:space:]]+push([[:space:]]|$) ]] &&
  ! [[ "$command" =~ (^|[\;\&\|[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$) ]]; then
  exit 0
fi

jq -n '
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: "did you apply opentofu before git push?"
  }
}'
