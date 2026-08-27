# Daytona had retained the agent token

## What was wrong

Every sandbox turn was launched as `env KEY=value ... agent`. Daytona retains the complete command
for a process session, so both the short-lived LLM proxy access token and its longer-lived refresh
token appeared in provider session metadata. Keeping the tokens out of files was not enough: the
provider command itself was durable state.

This was observed in the production Chrome acceptance run by inspecting the real Daytona session,
not inferred from the local Docker substitute described in the original sandbox handoff.

## Why the checks missed it

The agent test asserted that the command contained the proxy access token and only checked that it
did not contain a raw model-provider key. That proved the opposite of the boundary we needed. The
Daytona driver tests covered command quoting and streaming behavior, but did not record the command
metadata, input echo, or logs as separate provider surfaces.

## What stops it coming back

Sensitive turns now start one fixed, credential-free Node launcher. The actual argv and environment
arrive once through Daytona's session-input endpoint with `suppressInputEcho: true`; the launcher
reads one JSON line, spawns the agent with that environment, and retains no copy in the workspace.
The successful session remains alive exactly as before, so descendant development servers continue
to power signed previews until the sandbox is stopped or destroyed.

Adversarial tests record the provider command request, session metadata, stdout, stderr, and file
surface and assert that neither token appears in any of them. They separately assert that the only
transport carrying the values is suppressed session input and that successful sessions are kept.

## Launch-plan context

This closes a production-only acceptance gap from both legacy launch plans,
`read-the-readme-md-to-eventual-dusk.md` and `double-sorted-meteor.md`, and the reporting/handoff
notes `private_notes/groups.md` and `private_notes/sandbox-handoff.md`. Those documents require the
real Daytona and production-Chrome path precisely because the earlier Docker implementation had no
provider session metadata in which this failure could appear.
