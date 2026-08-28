# CloudFront standard logs are not a provider ledger

## What was wrong

Static-site request and egress metering correctly consumed CloudFront standard-v2 logs through S3,
the durable metering outbox, Kafka, and ClickHouse. The importer was retry-safe, but nothing checked
whether CloudFront had omitted a request. AWS documents standard logs as best effort: entries can be
delayed for a day and, rarely, never delivered. A completely healthy importer could therefore bill
less traffic than the provider observed while every job stayed green.

That gap is not permission to guess which tenant caused the missing traffic. The shared
distribution's provider aggregate can prove that a residual exists, but it cannot reconstruct the
hostname or project of an omitted request.

## Fix

- An hourly job rechecks the last three closed UTC days.
- It compares CloudFront's aggregate `Requests` and `BytesDownloaded` metrics with deduplicated
  `usage_event_raw FINAL` totals whose source is `cloudfront-standard-v2`.
- The absolute comparison is persisted per distribution/day. During the delivery grace window a
  residual is `pending_delivery`; after it, the residual is `platform_overhead`.
- Reconciliation never emits a usage event, updates a rollup, places a hold, or posts a ledger
  entry. Missing attribution therefore cannot become a guessed tenant charge.
- Structured worker logs expose provider, imported, and residual totals. The source rows retain
  their CloudFront-observed timestamps and request IDs.

The billing hard floor remains the credit safeguard: asynchronous charges debit at most prepaid
credit and settle the whole measured quantity, so delayed delivery cannot create debt. Pending
provider residual is not subtracted from a customer's available balance because no customer owns
it yet.

## Why this is not real-time logging

The launch architecture intentionally uses standard logs. If seconds-level visibility becomes a
product requirement, the replacement is 100% CloudFront real-time logs through Kinesis and a
checkpointed consumer. Sampling would be invalid for billing, and routing cache hits through Rust
only to observe them would discard the point of CloudFront.

## What now has to fail

- A provider residual older than the grace period must persist as `platform_overhead`.
- A late or corrected aggregate must replace the same distribution/day row rather than add to it.
- Duplicate S3 files and importer retries must converge under stable CloudFront request IDs and
  ClickHouse `FINAL`.
- Any change that turns a reconciliation residual into tenant usage or a ledger debit violates the
  explicit no-allocation boundary.
