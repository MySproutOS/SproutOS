# Child agents did not inherit the platform

## What was wrong

The Daytona images already carried two coding harnesses capable of delegation, but SproutOS had no
delegation contract. Claude Code exposed its `Agent` tool with upstream defaults of twenty running
children and three nested layers. Codex exposed multi-agent tools without a SproutOS-owned cap.
That was an unsafe fit for a sandbox fixed at two vCPUs and 4 GiB.

More importantly, the main Claude process received SproutOS's platform instructions through
`--append-system-prompt-file`, but Claude's documented behavior is that a child receives its own
prompt rather than the main system prompt. A delegated child could therefore miss the database,
network, preview, commit, and deployment rules that made the parent safe and useful. The presence of
the instruction file proved only the main-agent path.

There were also no platform-owned small and large roles. Letting a harness choose an arbitrary child
model would have been especially wrong for BYO: a role pinned to Terra would replace the model and
provider the customer deliberately selected.

## Why the checks missed it

The sandbox tests asserted only the main process's argv and environment. None inspected child-agent
limits, definitions, model inheritance, or the prompt propagated below the main thread. No child was
started in the original Docker substitute, and the later Daytona acceptance work exercised one
main-agent turn at a time.

The exact supported controls are version-sensitive. The image pins were checked first, then the
installed CLI help/config parser and current vendor documentation were used before encoding them:
Claude Code supports
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, session-scoped
`--agents`, and `--append-subagent-system-prompt`; Codex supports
`agents.enabled`, `agents.max_concurrent_threads_per_session`, and custom agent TOML files. Codex
does not document a per-role turn limit or a nesting-depth setting, so neither is invented here.

## What stops it coming back

Both harnesses now receive one platform-owned policy: delegate only independent work, use at most
two concurrent children, avoid overlapping edits, wait for every child, inspect its result, and keep
final integration and verification with the parent.

Claude enforces two concurrent children and two nested layers in its environment. Its session gets
`small` and `large` definitions that inherit the parent model and stop at 8 and 24 turns
respectively. On platform Terra they also select low and high effort; on a BYO model they inherit
effort because supported levels are model-specific. Every Claude turn also reads the exact platform
`AGENTS.md` and appends it to every child and nested child.

Codex enforces two concurrent spawned threads on the command line and loads `small` and `large` role
files from the platform-owned `CODEX_HOME`. Those roles omit `model`, preserving Terra for platform
credit and the selected model/provider for BYO. They differ by low versus high effort on Terra and
inherit effort on other models. The files refresh before every Codex turn, so existing sandboxes are
upgraded and a later credential change cannot retain a Terra-only override. The global `AGENTS.md`
supplies the same platform policy to their threads. Deterministic tests parse the actual Claude role
JSON, inspect the Codex TOML and invocation overrides, and assert the model-and-effort inheritance
boundary.

## Launch-plan and reporting context

This closes a sandbox capability gap carried through both legacy launch plans,
`read-the-readme-md-to-eventual-dusk.md` and `double-sorted-meteor.md`, and through the implementation
reporting in `private_notes/groups.md` and `private_notes/sandbox-handoff.md`. The handoff is
particularly load-bearing: it records that the original verification used Docker rather than
Daytona, so it could not establish what the pinned production harnesses actually exposed or passed
to their children.
