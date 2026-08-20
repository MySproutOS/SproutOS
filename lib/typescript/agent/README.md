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

`rateTokens` reads `price_book_item` for `ai_input_token`, `ai_output_token`, and
`ai_cache_read_token`. Rates are decimal strings, not integers, because a cache-read token costs
0.33 micro-USD and an integer rate floors to zero — the dimension would bill nothing, forever.

`NoActivePriceBookError` is thrown rather than defaulting to zero. Zero-cost usage is
indistinguishable from free usage on a statement, which makes it the most expensive silent failure
this system can have.

## Two ledgers, on purpose

The credit ledger says what was **charged**. `usage_event` says what was **consumed**, per
dimension. `withMeteredRun` writes both, keyed on the hold id, so a retried settlement collides on
`(source, external_id, occurred_at)` rather than double-counting. A charge with no matching events
is a bill nobody can explain.
