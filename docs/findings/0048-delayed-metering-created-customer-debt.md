# Delayed metering created customer debt

## What was wrong

SproutOS presents credit as prepaid, but the asynchronous usage charger deliberately bypassed the
balance check and posted the full charge. A late ClickHouse import could therefore take
`user_credit` below zero. The billing page then showed a debt, and a later top-up paid that old
overage before funding new work.

That contradicts the product boundary. Holds and admission checks are intended to stop expensive
work before credit runs out. When delayed measurement still exceeds the remaining credit, that lag
is platform risk; it is not permission to create customer debt.

The same review found a display variant of the BYO-model bug recorded in finding 0047: billing
views rated the full rollup quantity even when `externally_charged_quantity` said the user's model
provider had already settled part of it.

## Why the existing checks passed

The negative-balance behavior was documented in `charge.ts` and explicitly asserted by its test.
The ledger itself remained perfectly balanced: every negative customer posting had an equal
positive revenue posting. Double-entry accounting prevented money from appearing or disappearing,
but it could not decide whether debt was a valid product state.

The usage page also returned arithmetically correct prices for the quantity it selected. No test
put externally charged AI quantity in a rollup and asked whether the Cost column was zero.

## Fix

- The charger locks the organization's credit account and debits at most the available prepaid
  balance.
- It marks the full delayed rollup quantity settled even when some overage is forgiven, so a later
  top-up cannot be consumed by old usage.
- Partial payment is allocated to resource usage before overhead.
- Usage, project-rating, and listing-estimate queries rate only
  `quantity - externally_charged_quantity`, while still showing total usage volume.
- Regression tests drain an account to its last credit, prove it stops at zero, top it up again,
  and prove the old overage does not return.

## Historical context retained

This finding continues the launch and sandbox work described in:

- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`
- `/Users/andrew/.claude/plans/double-sorted-meteor.md`
- `private_notes/groups.md`
- `private_notes/sandbox-handoff.md`

Those documents explain why real-provider and production verification matters here: the negative
balance appeared only after delayed production meters and the charge job interacted. The finding is
the durable repository record of the invariant those reports exposed.

## What now has to fail

Any regression that posts more than the locked available balance makes the hard-floor test observe
a negative balance. Any regression that leaves forgiven quantity chargeable makes the later-top-up
assertion fail. Any billing view that rates BYO quantity makes the externally charged usage test
show a non-zero SproutOS cost.
