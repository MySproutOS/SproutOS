#!/bin/bash
#
# Stop hook: check the work against Andrew's stated direction before handing back.
#
# `private_notes/groups.md` holds his requirements verbatim. This exists because a plan is read
# once and a requirement is forgotten many times — most of what went wrong in the work this guards
# was not a misunderstanding, it was a detail that had been stated and then drifted from.
#
# Deliberately advisory (exit 0 + additionalContext), not blocking (exit 2). A Stop hook that
# blocks fights the user for control of their own turn, and Claude Code overrides it after eight
# consecutive blocks anyway — so a blocking version would be both hostile and, in the case that
# matters most, ineffective.
#
# Fires only when the working tree actually changed. "Every time it's done implementing something"
# is the requirement; a reminder on every conversational turn is noise, and noise is what makes a
# guardrail get switched off.

set -uo pipefail

INPUT=$(cat)
NOTES="private_notes/groups.md"

# Already blocking, or on the way out. Do not pile on.
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# No notes, no check — and say nothing. A hook that complains about its own missing config on every
# turn trains the reader to ignore it.
[ -f "$NOTES" ] || exit 0

# Nothing implemented this turn.
if git diff --quiet HEAD 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

CHANGED=$(git status --porcelain 2>/dev/null | head -20)

jq -n --arg notes "$NOTES" --arg changed "$CHANGED" '
{
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: (
      "Before reporting this done: re-read \($notes). It holds Andrew'"'"'s requirements verbatim.\n\n" +
      "Check the work you just did against what he actually asked for — not against your plan, which " +
      "is a paraphrase. Where they disagree, he is right.\n\n" +
      "Uncommitted changes this turn:\n\($changed)"
    )
  }
}'
exit 0
