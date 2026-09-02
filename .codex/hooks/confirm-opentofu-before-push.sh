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
  systemMessage: "Reminder: confirm whether production OpenTofu needs to be planned and applied before pushing or merging this change."
}'
