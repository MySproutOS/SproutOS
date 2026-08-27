# @lib/agent

Which model credential an agent run uses, and who pays for the tokens it burns.

## Four credential kinds, two billing models

`agent_credential.kind` is one of `claude_subscription`, `anthropic_api_key`, `openai_api_key`,
`openrouter_api_key`. What actually changes how a run behaves is not the kind but who is billed:

|                | Key                 | Billed               | Reserved first         |
| -------------- | ------------------- | -------------------- | ---------------------- |
| **`byo`**      | the customer's      | by their provider    | no                     |
| **`platform`** | ours (`OPENAI_KEY`) | their credit balance | **yes**                |
| **`none`**     | —                   | —                    | the run does not start |

For `byo` we have no claim to press — their key, their bill, and an overrun is between them and
their provider. Tokens are still counted, because usage is worth showing even when there is
nothing to charge for it.

`platform` is the case with teeth. Every token is our money first, so the run is held against
their balance before it starts and metered as it goes.

## Resolution order, and the trap it avoids

`resolveAgentCredential(db, orgId, projectId)`:

1. Project-scoped `agent_config` if there is one, else the organization's. **Scope wins outright
   rather than merging field by field** — this project's model with the organization's credential
   is a combination nobody chose, and the one that surprises people when the bill arrives.
2. A named `agent_credential_id` wins, even when credits are also enabled. It is what the customer
   set up deliberately and the one that costs them nothing extra.
3. A revoked or deleted credential resolves to **`none`**, never to credits.
4. Credits only when `use_sproutos_credits` is explicitly true.

Step 3 is the whole reason `agent_config.agent_credential_id` may stay `ON DELETE SET NULL`.
Falling through to the platform key on revocation would mean _revoking your API key starts charging
your balance_ — the opposite of what revoking a key means. `agent.test.ts` asserts it directly.

## The secret

Sealed with `@lib/envelope` under a context this package exports:

```ts
credentialContext(organizationId, credentialId)
// { field: "agent_credential.secret", credentialId, organizationId }
```

**One function, imported by both the writer and the reader.** KMS authenticates the context, so a
one-word difference between seal and open is a credential that stores fine and never opens again —
which is exactly the bug this shape prevents. Both ids are in it: without `credentialId` a
ciphertext moved onto another row in the same organization would open; without `organizationId`,
one lifted into another tenant's row would.

There is no reveal endpoint and no `secret` field in any response schema. `lastFour` is how a
person tells two keys apart, and it is all they get.

## Metering a platform-billed run

`withMeteredRun` is the only correct way to spend our key:

1. **Reserve first.** Tokens are bought from the provider as the run proceeds, so checking the
   balance afterwards discovers an overdraft it is already too late to prevent.
2. **Meter per request, not per run**, so a crash mid-run still leaves a settleable total.
3. **Settle what actually happened.** Anything unused returns to the balance immediately.
4. **Release on failure** when nothing was spent, so a run that threw at the first step does not
   strand a customer's balance until the reaper notices.

The reservation is a guess, deliberately biased high: too small aborts work the customer could
afford, too large only makes the remainder briefly unavailable. It is priced entirely as _output_
tokens — the most expensive dimension — so it is an upper bound on any mix.

An overrun settles in full rather than being capped at the reservation. The hold is a guard
against starting work that obviously cannot be paid for, not a ceiling on a provider's final bill;
discarding the excess would mean paying for it ourselves.

## Rates come from the price book, and a missing one throws

`rateTokens` reads one `price_book_item` for each provider token bucket, including cache writes and
request-scoped long-context input, output, and cache reads. Rates are decimal strings, not integers,
because a cached Terra input token costs 0.2 micro-USD and an integer rate floors to zero.

`NoActivePriceBookError` is thrown rather than defaulting to zero. Zero-cost usage is
indistinguishable from free usage on a statement, which makes it the most expensive silent failure
this system can have.

## Two ledgers, on purpose

The credit ledger says what was **charged**. The Kafka/ClickHouse usage stream says what was
**consumed**, per dimension. `withMeteredRun` commits token events and `agent_run_second` through
the transactional metering outbox beside settlement, using one run id and one observation
timestamp. Zero quantities are omitted, and retrying the outbox cannot restamp or double-count the
run. Agent duration is operational telemetry with a zero active rate; sandbox and token dimensions
already carry the provider cost. A charge with no matching events is a bill nobody can explain.

## Running a turn

`runAgentTurn` drives `@anthropic-ai/claude-agent-sdk`, which spawns a Claude Code subprocess.
Everything below follows from that one fact.

### The subprocess environment is built, not inherited

`Options.env` **replaces** the subprocess environment rather than merging with `process.env`, and
that is the property `env.ts` exists to use. The API process holds `DATABASE_URL`,
`STRIPE_SECRET_KEY`, `OPENAI_KEY`, the KMS configuration, and every other organization's decrypted
credentials as they pass through it. Inheriting that into a process whose job is to run a model
against a customer's repository puts all of it one `printenv` away from whatever the model decides
to do.

So the allowlist is `PATH HOME SHELL LANG LC_ALL TZ TMPDIR`, plus the one credential, by kind:

| kind                                    | variable                                      |
| --------------------------------------- | --------------------------------------------- |
| `claude_subscription`                   | `CLAUDE_CODE_OAUTH_TOKEN`                     |
| `anthropic_api_key`                     | `ANTHROPIC_API_KEY`                           |
| `openai_api_key` / `openrouter_api_key` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |

The last row **requires** `base_url`. Claude Code reaches a third party through the Anthropic-shaped
variables, so the endpoint has to speak that protocol; a bare OpenAI key does not, and starting the
run anyway would send the customer's key to `api.anthropic.com`. `env.test.ts` asserts the
allowlist as an allowlist, and fails if anything new appears in it.

**Platform credits do not use this runner.** Our key is OpenAI's, which is not an Anthropic-shaped
endpoint, so `agentSubprocessEnv` throws rather than building an environment with no credential in
it and letting the subprocess fall back to whatever the host happens to have configured.

### The checkout carries no credential

`git clone https://x-access-token:TOKEN@github.com/...` writes the token into `.git/config`, inside
the directory the agent is about to read. `-c http.extraHeader=...` keeps it out of the config and
puts it in argv, where `ps` shows it to anything on the host.

`gitAuthEnv` uses `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`: per-process, not in argv, never
written to disk. The remote is then rewritten to the plain URL, so the config is credential-free
rather than assumed to be. **The agent never gets a push credential** — its output leaves through a
pull request opened by the control plane.

`workspace.ts` is the _development_ driver. In production the checkout is prepared inside the Kata
VM that isolates the session; cloning onto the API host is only acceptable while there is no
compute plane.

### Token accounting reads `modelUsage`, not `usage`

`usage` covers the main agent loop only — it excludes Task subagents, sidechains, and internal
calls like compaction, all of which are real model calls a customer's key really pays for.
`modelUsage` is cumulative across turns and each result carries the running total, so the **latest**
result is read rather than summed.

Cache _creation_ tokens rate as input, because that is what they cost. Only cache _reads_ get the
discounted rate; folding creation into the cache-read dimension would under-bill the first request
of every conversation.

### Verified against a live model

A real turn on a `claude_subscription` credential: the agent read a file with Bash and Read, and
returned 20,335 input / 323 output / 57,080 cache-read tokens in 4 turns. Rated against the seeded
price book that is **$0.091273** of usage plus **$0.010953** of overhead — and the arithmetic is
exactly `57,080 × 0.33` micro-USD for the cache reads, the dimension an integer rate would have
floored to zero.

`chargedMicroUsd` was `0`, which is correct: a customer's own credential costs us nothing.

### The SSE route is hidden from the OpenAPI document

hey-api models a response as one JSON body, so a streaming route would get a generated client
method that resolves on the first chunk and drops the rest — a function that compiles, runs, and is
wrong.

Excluding it through `input.filters.operations.exclude` in the openapi-ts config is the obvious
move and does **not** work: this version accepts the option and ignores it, which is worse than not
supporting it. `describeRoute({ hide: true })` is the thing that holds — it removes the method from
the path, leaving the path key with no operations, and the generated client has no method for it.

## The other runner: chat on platform credit

`runPlatformChat` is what a customer paying out of credits gets. It exists because our key is
OpenAI's and OpenAI is not an Anthropic-shaped endpoint Claude Code can be pointed at, so the two
billing models genuinely need two runners.

**It answers questions; it does not edit files.** No tools, no checkout, no pull request — giving a
second model harness write access to a customer's repository is not a thing to add quietly. Its
system prompt says so, and the route sends it down a path that needs no repository at all, which is
why credit-billed chat works today while the agent runner is still waiting on the GitHub App.

The key never leaves the API process: no subprocess to inherit it, no tenant VM to hand it to.

### `max_completion_tokens` is headroom, not answer length

On a reasoning model the budget covers reasoning _and_ the visible reply, and the reasoning comes
first. Observed: a one-word answer spent **128 reasoning tokens and 11 visible ones**. Set the cap
to 64 and the model uses all of it thinking, stops with `finish_reason: "length"`, and returns an
empty string — having charged for 64 tokens.

The default is 8192, and a run that ends truncated with nothing to show says so rather than
presenting a blank answer alongside a charge.

### Two ways to get the bill wrong, in opposite directions

`toTokenUsage` is a pure function with tests, because neither mistake fails visibly:

|                                                           | what happens if you get it wrong                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `prompt_tokens` **includes** cached tokens                | leaving them in charges the full input rate for text the model never reprocessed — most of a long conversation |
| `completion_tokens` **already includes** reasoning tokens | adding `reasoning_tokens` on top double-bills the most expensive dimension                                     |

Real numbers from a live call: `prompt_tokens: 14, completion_tokens: 139,
completion_tokens_details.reasoning_tokens: 128`.

### Verified against the real key and a real balance

```
before:  posted $5.00   held $0.00        available $5.00
reply:   "zorblatt"
usage:   { inputTokens: 94, outputTokens: 139, cacheReadTokens: 0 }
holds:   [ { status: 'settled', amount: '$0.605553' } ]
charged: $0.002918
after:   posted $4.997082  held $0.00     available $4.997082
```

`94 × 3.3 + 139 × 16.5 = 2,605` micro-USD, plus 12% overhead, is exactly `$0.002918`. The hold
reserved $0.605553 up front and returned everything unused at settlement.

### The conversation is replayed, not remembered

A chat completion has no memory, so every turn resends the exchange. `priorMessages` rebuilds it
from `agent_turn` (the prompts) and `agent_event` (the replies) rather than from process memory,
because the process that served turn one is not necessarily the one serving turn two.

It is capped at the last 20 messages. A conversation replayed in full is a bill that grows
quadratically in the number of turns, since every turn resends every earlier one.
