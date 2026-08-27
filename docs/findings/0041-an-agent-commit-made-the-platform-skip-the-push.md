# An agent commit made the platform skip the push

## What was wrong

The platform owns the short-lived GitHub credential and is supposed to push sandbox work after a
turn. Its handoff treated a clean worktree as “no changes” and returned before reading HEAD. When a
model ran `git commit` itself, the worktree was clean precisely because the work had been preserved
in a local commit. The platform therefore skipped the push and the commit remained only on the
paid Daytona filesystem.

The production Chrome acceptance turn exposed this after creating `c12eea3`: the model could not
push without a credential, and the platform emitted no committed branch afterward.

## Why the earlier checks passed

Tests covered an uncommitted dirty worktree and a genuinely unchanged clean worktree. The live push
test deliberately wrote files without committing them. Nothing covered the ordinary coding-agent
behavior of committing before it reports completion.

This is part of the sandbox handoff in `private_notes/sandbox-handoff.md`, the grouping requirements
in `private_notes/groups.md`, and the legacy plans
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` and
`/Users/andrew/.claude/plans/double-sorted-meteor.md`.

## What stops it recurring

- A clean worktree is compared with the remote-tracking production branch cloned at bootstrap.
- If HEAD already contains changed files, the platform preserves that commit and pushes it to the
  session's assigned `sproutos/agent-*` ref without creating a second commit.
- A truly unchanged checkout still creates no empty branch, and an empty commit alone is not treated
  as customer work.
- The GitHub credential remains platform-owned and ephemeral; this change does not put it in the
  sandbox remote or on disk.
- A focused test reproduces a clean, already-committed `docs/launch-smoke.md` and requires the push.
