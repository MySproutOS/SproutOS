# 0025 — Only the first agent turn could push

The production model created the requested verification file, and the platform committed it in the
Daytona checkout. The remote `sproutos/agent-*` branch did not move. A following turn showed a
clean working tree and the new local commit, while GitHub still pointed at the previous commit.

The push used bare `--force-with-lease` against a URL. Git can only infer that lease from a local
remote-tracking ref. The sandbox clone never fetched its session branch, so the first turn could
create a branch that did not exist, but every later turn treated that existing branch as unexpected
and rejected its own push. The commit remained only on the paid workspace until deletion.

## Why the previous checks passed

The live push test used a new bare remote and made one push. The unit test also modeled one push to
an absent branch. Neither performed two turns against the same branch, which is the normal product
flow. The UI streamed the model response before commit-and-push and did not make the later
`commit_failed` event prominent in the transcript, so a clean next-turn working tree looked like
success unless GitHub was read independently.

This repeats the external-effect rule in
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: a local commit is not a pushed
branch. It also preserves the real-provider boundary of
`/Users/andrew/.claude/plans/double-sorted-meteor.md` and `private_notes/sandbox-handoff.md`; the
single-push driver demonstration did not prove a multi-turn Daytona session.

## What stops it coming back

Before changing the checkout, the platform now performs an authenticated `git ls-remote` for the
exact session branch. The push supplies that observed object id as the explicit lease. An absent
branch gets an explicit empty lease and may be created; an existing branch may move only from the
SHA this turn observed. A concurrent or external update still rejects the push instead of being
overwritten.

Tests cover both the absent first push and an update to an existing branch, and assert that neither
the remote URL nor the command-line ref contains the installation token.
