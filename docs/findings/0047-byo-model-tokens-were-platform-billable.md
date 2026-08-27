# BYO model tokens were platform-billable

## What was wrong

An `agent_proxy_token` already recorded the billing fork authoritatively:
`agent_credential_id` is present for a customer-provided provider credential and null for the
platform key. The LLM proxy used the row to choose the upstream credential, then discarded that
fact. Its model-token events had no external-charge field, and signed ingest hardcoded every event
to `chargedExternally: false`.

The result was internally consistent and wrong. BYO input, output, and cache-read token events
remained visible in ClickHouse and the usage dashboard, but the rollup importer treated all of them
as unpaid. `chargeUsage` could therefore debit SproutOS credit for provider usage the customer had
already paid for directly. Agent runtime remains a separate platform resource and is not changed by
this fix.

## Why the checks missed it

The TypeScript agent-run path already carried `chargedExternally`, and billing tests proved that an
externally settled rollup was not charged twice. Separately, the Rust proxy end-to-end test proved
that token counts reached signed ingest. No test joined the two paths, so the proxy could lose the
billing decision between an authoritative token row and a valid metering batch while every
component-level check remained green.

## What stops it coming back

- Session resolution derives `charged_externally` directly from
  `agent_proxy_token.agent_credential_id is not null`.
- Every new LLM proxy token event explicitly signs `charged_externally: true` for BYO or `false`
  for the platform key.
- The cross-language schema treats absence as the legacy shape. Canonicalization omits the field
  only when absent, so already-spooled batches keep their original signatures; explicit true and
  false values are covered by distinct signatures.
- Signed ingest preserves the flag into Kafka and ClickHouse instead of manufacturing `false`.
- Rust, TypeScript, proxy/database end-to-end, ingest, and charge tests pin both branches: BYO usage
  is visible with its quantity already paid, while platform-key usage remains chargeable.

## Launch-plan context

The intended cost and credential boundaries are spread across both legacy plans and both private
handoffs, so this finding keeps all four attached to the correction:

- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md`
- `/Users/andrew/.claude/plans/double-sorted-meteor.md`
- `private_notes/groups.md`
- `private_notes/sandbox-handoff.md`

The handoff's warning matters here: a stub proving that the proxy counted tokens did not prove the
production billing classification. The classification now originates in the same durable row that
selects the customer credential and survives the signed data path explicitly.
