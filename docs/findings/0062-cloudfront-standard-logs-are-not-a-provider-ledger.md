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
- It compares CloudFront's aggregate `Requests` metric with deduplicated `site_request` rows from
  `usage_event_raw FINAL` whose source is `cloudfront-standard-v2`.
- The absolute comparison is persisted per distribution/day. During the delivery grace window a
  residual is `pending_delivery`; after it, the residual is `platform_overhead`.
- Reconciliation never emits a usage event, updates a rollup, places a hold, or posts a ledger
  entry. Missing attribution therefore cannot become a guessed tenant charge.
- Structured worker logs expose provider, imported, and residual totals. The source rows retain
  their CloudFront-observed timestamps and request IDs.

This is deliberately a request-count delivery signal, not a byte or financial reconciliation.
AWS defines `Requests` as all viewer requests across HTTP methods, matching the one-row-per-viewer-
request boundary of standard logs. By contrast, `sc-bytes` is the whole server-to-viewer response,
including headers and every method, while CloudWatch `BytesDownloaded` covers only `GET` and
`HEAD`. AWS does not define those byte values as equivalent. Comparing them would create a false
residual whenever their method or header boundaries differ, so the durable reconciliation table,
logs, metrics, and alarm contain request counts only.

Tenant `site_egress_byte` remains the explicit price-book quantity from standard-log `sc-bytes`.
It is not represented as provider-equivalent data transfer and is never backfilled from a shared
distribution aggregate. A future provider-cost reconciliation needs a distribution-scoped billing
or usage export with a deliberately mapped byte definition; it cannot reuse `BytesDownloaded`.

AWS definitions used for this boundary:

- [Standard-log fields](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logs-reference.html)
  define `sc-bytes` as server-to-viewer response bytes including headers.
- [CloudFront CloudWatch metrics](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html)
  define `Requests` across viewer requests and `BytesDownloaded` only for `GET` and `HEAD`.
- [Standard-log delivery behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/AccessLogs.html)
  explicitly warns that omitted log entries do not match AWS billing and usage reports.

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

- A provider request-count residual older than the grace period must persist as
  `platform_overhead`.
- No CloudWatch byte metric may be persisted or compared with `sc-bytes` without an AWS-documented
  equivalence for methods and headers.
- A late or corrected aggregate must replace the same distribution/day row rather than add to it.
- Duplicate S3 files and importer retries must converge under stable CloudFront request IDs and
  ClickHouse `FINAL`.
- Any change that turns a reconciliation residual into tenant usage or a ledger debit violates the
  explicit no-allocation boundary.
