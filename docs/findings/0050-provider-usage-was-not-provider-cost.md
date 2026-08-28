# 0050 — Provider usage was not provider cost

Daytona reported 27,360 CPU-seconds, 54,720 GiB-seconds of memory, and 160,920
GiB-seconds of disk for the live account. Those account totals are not directly comparable with
SproutOS's six metered sandboxes: Daytona's export also contains 149 other sandboxes. The six
provider resources that can be mapped to SproutOS total 26,318 CPU-seconds and 141,360
GiB-seconds of disk, while SproutOS reported 33,287.062 and 166,435.31 respectively.

The initial explanation for that gap was wrong. The first SproutOS windows align with the mapped
Daytona creation timestamps, so there is no evidence that pre-provider `created_at` time caused the
historical overage. One concrete event instead spans a provider stop/restart gap: Daytona stopped
the resource at 17:10:28Z and restarted it at 17:25:24Z, while SproutOS emitted one interval from
17:09:57.923Z through 17:25:27.379Z. That row contains both legitimate and stopped time, so zeroing
the event would undercount. Historical quantities must not be rewritten until an authoritative
per-resource provider interval export or an explicitly approved aggregate adjustment supplies the
correction quantities.

One separate set is exact: Daytona records resource
`b6c18a7b-93b4-422e-8c93-9bec5b1a9f2a` as successfully deleted at 07:12:48Z, while the mapped
SproutOS resource `01a0414c-b28a-73ca-90f6-c35b032df6f9` emitted 27 events beginning between
13:55:09Z and 14:39:52Z. Nine events per resource dimension total 5,365.642 CPU-seconds,
10,731.284 GiB-seconds of memory, and 26,828.21 GiB-seconds of disk. Those events are safe to
replace with zero-quantity higher versions; the mixed stop/restart interval above is not.

## What changed

- A sandbox without `external_id` is never meterable, including after the row lock is acquired.
  The second check closes a latent race where provider recovery clears the id after the scheduler's
  first query. This invariant prevents unbacked future usage; it is not presented as the cause of
  the historical discrepancy above.
- Price-book items can override the book-wide fee. Missing overrides retain the existing 12%; Neon
  compute uses 2%, while Neon storage, Daytona resources, platform-funded AI, and operational agent
  duration use 0%.
- Daytona CPU, memory, and disk use the provider's exact per-second rates. Agent duration remains a
  useful operational measurement but has a zero rate and is omitted from customer cost lines.
- Platform-funded `gpt-5.6-terra` traffic has distinct ordinary input, cached input, cache write,
  output, and request-scoped long-context buckets. The proxy refuses another platform-funded model
  rather than inventing a rate. BYO events carry a signed external-cost
  marker and remain visible without a SproutOS charge.
- The billing UI groups measured queue residency under Queue as **Queue storage**. Cache remains a
  separate category and does not claim ordinary Valkey cache memory is metered; no writer exists
  for that usage today.
- A stopped Daytona container continues billing reserved disk until archive or deletion. Stopped
  provider-backed rows therefore emit disk usage only; CPU and memory stop with the container.

- Sandbox egress is measured at the authenticated Rust forward-proxy boundary and stored as
  `sandbox_egress_byte`. The price is AWS US-East internet data transfer at $0.09 per decimal GB,
  because Daytona sends internet traffic through our proxy and AWS is the provider charging that
  leg. Its item-level fee is 0%; this is not an invented Daytona network rate.

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

Neon's current consumption guide is also a unit contract: v2 `*_bytes_month` values are byte-months,
GB means exactly 1,000,000,000 bytes, and Neon has already applied its fixed 744-hour billing month.
The current meter therefore writes decimal `db_storage_gb_month` directly. The v2 book retains the
legacy `db_storage_gib_hour` item at its algebraically equivalent rate so rollups written earlier in
the same billing period remain rateable during deployment.

The same API exposes instant-restore history separately, so it is metered as
`db_history_storage_gb_month` at Neon's $0.20/GB-month with no platform fee. Snapshot storage is
currently free during beta and has no invented charge here. Extra branches and network transfer
have plan allowances and organization-level aggregation rules; they remain an explicit unallocated
provider-cost boundary rather than being mislabeled as database storage.
