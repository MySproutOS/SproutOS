# 0050 — Provider usage was not provider cost

Daytona reported 27,360 CPU-seconds, 54,720 GiB-seconds of memory, and 160,920
GiB-seconds of disk for the live account. SproutOS reported 33,287.062, 66,574.124, and
166,435.31 respectively. The discrepancy was not provider rounding: the scheduler metered a
`starting` row from `created_at` before that row had a Daytona `external_id`. Provisioning later
reset the watermark to the real provider creation time, but usage already emitted from the phantom
interval remained in the ledger.

The excess was 5,927.062 CPU-seconds, 11,854.124 GiB-seconds of memory, and 5,515.31
GiB-seconds of disk. At Daytona's rates that is 136,487.8853 micro-USD of nonexistent provider
usage. The provider-backed quantity costs 634,107.6 micro-USD ($0.6341076), which reconciles with
Daytona's displayed $0.64. The old Sprout quantity costs 770,595.4853 micro-USD before its 12% fee;
if all of it was charged under that book, the sandbox correction is 228,959.343536 micro-USD before
ledger rounding. The actual correction must use posted ledger entries, not this display arithmetic.

## What changed

- A sandbox without `external_id` is never meterable, including after the row lock is acquired.
  The second check closes the race where provider recovery clears the id after the scheduler's
  first query.
- Price-book items can override the book-wide fee. Missing overrides retain the existing 12%; Neon
  compute uses 2%, while Neon storage, Daytona resources, platform-funded AI, and operational agent
  duration use 0%.
- Daytona CPU, memory, and disk use the provider's exact per-second rates. Agent duration remains a
  useful operational measurement but has a zero rate and is omitted from customer cost lines.
- Platform-funded `gpt-5.6-terra` traffic has distinct ordinary input, cached input, cache write,
  output, and request-scoped long-context buckets. The proxy refuses another platform-funded model
  rather than inventing a rate. BYO events carry a signed external-cost
  marker and remain visible without a SproutOS charge.
- The billing UI groups measured queue residency under Cache as **Queue storage**. It does not claim
  ordinary Valkey cache memory is metered; no writer exists for that usage today.

Sandbox egress is intentionally outside this change. Its proxy instrumentation and provider-cost
source are a separate change; adding a guessed network rate here would recreate the same failure.

## Provenance and supersession

- `private_notes/sandbox-handoff.md` and finding 0021 preserve the distinction between Docker proof
  and Daytona proof.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` remains the metering architecture source,
  but its global-fee assumption is superseded by per-dimension provider-cost policy.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` remains authoritative on
  provider-observed verification. A locally increasing clock is not evidence of provider usage.

## The check that matters

The regression fixture creates an hour-old `starting` row with no provider id beside a provider-
backed `starting` row. Only the latter emits events, and the former's watermark stays null. Pricing
tests independently assert exact provider rates and zero item fees, so a future global fee change
cannot silently turn pass-through resources back into platform markup.
