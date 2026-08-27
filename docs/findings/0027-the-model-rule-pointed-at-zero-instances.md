# 0027 — The model rule pointed at zero instances

A production agent turn sat in Daytona until Claude Code returned `503 Service Temporarily
Unavailable`. The Daytona process was alive, but the load balancer sent 100 percent of
`llm.sproutos.me` traffic to the blue target group while the blue router Auto Scaling group had
desired capacity zero. The primary router listener was healthy on green.

`cutover.sh` already knew how to move the LLM rule with every other router endpoint. The production
workflow never passed `LLM_RULE_ARN` into that script, so its optional-rule behavior silently
omitted the model endpoint. The cutover then correctly drained the old router colour, turning the
stale LLM rule into a deterministic 503.

## Why the previous checks passed

The cutover tests invoked the script with `LLM_RULE_ARN` set and proved that the rule moved. They did
not prove the production workflow supplied that variable. The deployment checked and read back the
primary router listener, not every possible endpoint that shares the router instances.

This is another deployment-versus-runtime boundary from
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: a healthy front door does not
prove every protocol on the same release moved with it. It also closes a production-only gap from
`/Users/andrew/.claude/plans/double-sorted-meteor.md` and `private_notes/sandbox-handoff.md`; a stub
or a local Docker sandbox never traverses the production LLM load-balancer rule.

## What stops it coming back

Both production deployment stages now receive `LLM_RULE_ARN`, and OpenTofu exposes the canonical
rule ARN beside the other deployment outputs. That makes the model endpoint part of the same router
colour change as HTTP, Postgres, Valkey, search, and sandbox egress. The cutover test also reads the
production workflow and fails if either copy of that wiring is removed, instead of testing only the
script in isolation.
