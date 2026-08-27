# Platform instructions became customer work

**Found by:** inspecting the branch pushed by the first successful production Daytona turn.

## What looked true

The bootstrap wrote SproutOS instructions into `AGENTS.md` so every harness would see them, while
`.git/info/exclude` hid the platform skill and Codex state. The commit path was expected to contain
only files changed by the coding agent.

## What was actually true

The root `AGENTS.md` was neither excluded nor customer work. `commitSandboxWork` correctly ran
`git add -A`, so the platform-created file was swept into the agent branch beside the model's real
edit. Worse, if a repository already tracked `AGENTS.md`, bootstrap overwrote the customer's own
instructions; an ignore rule cannot hide a modification to a tracked file.

Trying to subtract that file at commit time would make ownership ambiguous: the model is allowed to
edit a real repository `AGENTS.md`, and the commit path cannot distinguish that edit from the
platform's earlier overwrite.

## What stops it recurring

The platform instruction file and Codex home now live under `.git/sproutos/`, outside the worktree.
Codex reads the file as `$CODEX_HOME/AGENTS.md` and then layers the repository's own instructions,
which is the global-to-project discovery order documented by Codex. Claude Code receives the same
file explicitly with `--append-system-prompt-file`. No platform instruction, ignore rule, or harness
state is written into the customer's tree.

Tests assert that bootstrap writes no root `AGENTS.md`, preserves an existing one byte-for-byte,
places Codex home beneath Git metadata, and passes the instruction file explicitly to Claude Code.

## Historical context

This corrects the commit and injected-skill claims in `private_notes/groups.md` and
`private_notes/sandbox-handoff.md`. It is part of the launch chain recorded in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.
