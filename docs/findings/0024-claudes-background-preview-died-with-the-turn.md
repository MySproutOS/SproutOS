# 0024 — Claude's background preview died with the turn

The first real model-created preview listened on `0.0.0.0:3000`, returned the expected body to a
local `curl`, and was reported by Claude Code as a background task. When that turn completed,
Claude Code stopped its managed background task. The dashboard then minted a valid signed Daytona
preview URL and rendered Daytona's warning, but continuing into the preview returned
`502 proxy upstream error`. A second model turn confirmed that port 3000 had no listener and the
server process no longer existed.

The provider integration was sound. Starting the same server with `setsid -f`, stdin from
`/dev/null`, and output redirected under `/tmp` reparented it to PID 1. It survived the completed
turn, and the production dashboard iframe then rendered `sprout-production-preview` through the
signed Daytona URL.

## Why the previous checks passed

The live driver test launched a background process directly through Daytona and then fetched its
preview URL. It proved the driver and signed URL, but it did not launch the process as a real Claude
Code tool call or let the harness exit before fetching. Claude's managed-background cleanup was
therefore outside the interface the test demonstrated.

The injected skill also named the wrong checkout path, `/workspace`, inherited from the discarded
Docker driver. Daytona's durable checkout is `/home/daytona/workspace`. The ordinary working
directory hid that error during the successful turn, but an absolute-path instruction would not.

This is the exact production-parity boundary retained from
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: a process observed before its
owner exits is not evidence of a live external effect afterward. It also completes the preview
portion of `/Users/andrew/.claude/plans/double-sorted-meteor.md` against the real provider and real
harness rather than the legacy Docker substitute described in `private_notes/sandbox-handoff.md`.

## What stops it coming back

The sandbox section now receives the Daytona driver's actual workspace path. It tells both
harnesses to avoid Claude's `run_in_background` for previews, launch the server as a detached OS
process with redirected standard streams, and verify the response and parent PID 1 before ending
the turn. The live preview test uses the same `setsid` launch shape.

The same section makes the egress contract explicit: all public HTTP(S) domains work through the
preconfigured SproutOS proxy, there is no domain allow-list, and direct or private-address bypasses
are blocked. That is an instruction to use the enforced route, not a second network policy.
