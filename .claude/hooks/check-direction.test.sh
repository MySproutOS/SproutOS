#!/usr/bin/env bash

# The Stop hook is a guardrail only if Claude Code receives its reminder. Exercise the exact
# command from settings.local.json against a real dirty Git repository, then assert the recursion
# guard and clean-tree silence separately.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/sproutos-stop-hook.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email hook-test@sproutos.invalid
git -C "$FIXTURE" config user.name "Stop hook test"
mkdir -p "$FIXTURE/private_notes"
printf '%s\n' "The verbatim direction" >"$FIXTURE/private_notes/groups.md"
printf '%s\n' "before" >"$FIXTURE/work.txt"
git -C "$FIXTURE" add private_notes/groups.md work.txt
git -C "$FIXTURE" commit -qm fixture

printf '%s\n' "after" >"$FIXTURE/work.txt"
OUTPUT=$(
  printf '%s' '{"hook_event_name":"Stop","stop_hook_active":false}' |
    CLAUDE_PROJECT_DIR="$FIXTURE" "$ROOT/.claude/hooks/check-direction.sh"
)

printf '%s' "$OUTPUT" | jq -e '
  .hookSpecificOutput.hookEventName == "Stop" and
  (.hookSpecificOutput.additionalContext | contains("private_notes/groups.md")) and
  (.hookSpecificOutput.additionalContext | contains("M work.txt"))
' >/dev/null

# A Stop reminder causes another model turn. The next Stop carries this bit; emitting the reminder
# again would loop until Claude Code's hard cap rather than handing control back to the user.
ACTIVE_OUTPUT=$(
  printf '%s' '{"hook_event_name":"Stop","stop_hook_active":true}' |
    CLAUDE_PROJECT_DIR="$FIXTURE" "$ROOT/.claude/hooks/check-direction.sh"
)
test -z "$ACTIVE_OUTPUT"

git -C "$FIXTURE" restore work.txt
CLEAN_OUTPUT=$(
  printf '%s' '{"hook_event_name":"Stop","stop_hook_active":false}' |
    CLAUDE_PROJECT_DIR="$FIXTURE" "$ROOT/.claude/hooks/check-direction.sh"
)
test -z "$CLEAN_OUTPUT"

echo "Stop hook acceptance passed"
