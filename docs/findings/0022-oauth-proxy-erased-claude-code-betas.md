# 0022 — The OAuth proxy erased Claude Code's feature betas

## What was wrong

The LLM proxy correctly changed a Claude subscription credential from the sandbox's SproutOS
bearer to Anthropic's OAuth bearer and added `oauth-2025-04-20`. It did that by replacing the whole
`anthropic-beta` header.

Claude Code already sends that header with the feature opt-ins matching fields in its request body.
The first real production turn included `context_management`; after the proxy erased Claude Code's
betas, Anthropic rejected the request with:

```text
400 context_management: Extra inputs are not permitted
```

No model had answered. The CLI still exited through its normal structured-output path, so sandbox
creation, proxy authentication, and a streamed error could look like an agent turn had run.

## Why the previous checks passed

The proxy tests asserted the OAuth credential shape in isolation: Bearer authorization plus the
OAuth beta. They did not start with a client-supplied `anthropic-beta` header. Stubbed sandbox turns
did not exercise Anthropic's request schema, and direct Codex probes exercised the OpenAI upstream,
not the configured Claude subscription.

This is another instance of the verification rule in the legacy deployment plan
`/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`: a successful process and a
rendered response are not proof of the external effect. It also closes a production-parity gap in
`/Users/andrew/.claude/plans/double-sorted-meteor.md`: the isolation path has to preserve the model
client's protocol, not only its credential boundary.

## What stops it coming back

Provider-required headers now merge the OAuth beta into Anthropic's comma-separated beta list.
Tests begin with Claude Code's context-management beta, assert it survives, and assert the OAuth
beta is not duplicated. Production verification must include a real Claude subscription turn that
executes a shell command inside Daytona; a stub or an API-process fallback is insufficient.
