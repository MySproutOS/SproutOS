# 0064 — The refund needed a ledger proof

The launch test account had already received several manual billing corrections, but their
descriptions alone could not answer the question that matters: whether another correction was
still owed. A plausible description is not reconciliation. The proof has to join the immutable
credit ledger to the durable usage source and the price book that was active when each debit was
posted.

## Read-only production evidence

The reconciliation used a PostgreSQL `BEGIN TRANSACTION READ ONLY` session and ClickHouse `SELECT`
queries only. It made no credit, ledger, rollup, or raw-usage mutation.

At the time of the audit, the launch test organization had:

- 3,414,550 micro-USD of posted credit and no active holds;
- 5,154,962 micro-USD of metered-usage debits;
- 4,014,512 micro-USD of compensating adjustments; and
- 1,140,450 micro-USD of net metered spend after those adjustments.

The immutable compensating entries were:

| Reason                                                             | Credit (micro-USD) |
| ------------------------------------------------------------------ | -----------------: |
| Removed misclassified BYO model usage                              |            203,112 |
| BYO/model and sandbox markup, overhead, and phantom provider usage |          3,729,113 |
| PostgreSQL compute/storage pricing policy                          |             79,325 |
| Agent wall-clock fee and overhead                                  |              2,962 |
| **Total**                                                          |      **4,014,512** |

The 3,729,113-micro adjustment is one balanced transaction without statement line items. Its total
is exact; splitting it after the fact between model usage, sandbox markup, sandbox overhead, and
phantom quantity would be invented accounting. The source events removed during the correction no
longer supply that allocation.

## Why no additional AI or sandbox correction is due

ClickHouse `usage_event_raw FINAL` identifies every surviving BYO model event as
`charged_externally = true`. The externally charged quantities are 1,315,279 cache-read tokens,
358,902 cache-write tokens, 26,762 input tokens, and 14,165 output tokens. In the hourly PostgreSQL
projection, BYO-only grains have `externally_charged_quantity = quantity` and no ledger debit.

The separate platform-funded usage is 28,533 cache-write tokens, 9 input tokens, and 39 output
tokens. At the provider-pass-through price it costs 71,819 micro-USD and has a zero item fee. It is
legitimate platform-funded usage, not BYO usage.

The settled sandbox quantities re-rate, with the same row-level ceiling the charger uses, to:

| Dimension | Provider cost (micro-USD) |
| --------- | ------------------------: |
| CPU       |                   456,954 |
| Memory    |                   293,759 |
| Disk      |                     4,903 |
| Egress    |                    40,274 |
| **Total** |               **795,890** |

Every one of those price-book items has `overhead_bps = 0`. Egress is AWS internet transfer at the
authenticated Rust forward-proxy boundary; it is provider pass-through rather than a Daytona
network rate.

The timeline closes the remaining ambiguity. After the last manual correction and before price-book
v2 became effective, five usage transactions totaling 21,683 micro-USD were posted. None contains
an AI or sandbox grain. Every later AI and sandbox transaction used v2's zero-fee items. Therefore
the exact additional AI/sandbox adjustment is **0 micro-USD**.

## The separate PostgreSQL correction was applied exactly once

One 21,672-micro usage transaction landed after the earlier PostgreSQL correction but before v2
became effective. Its idempotency key is a SHA-256 digest of four `rollup-id=quantity` watermarks.
Three rollups still point to it; the fourth was later updated and points to a later transaction.
Recomputing the digest from the ClickHouse state imported immediately before the debit proves the
fourth grain rather than guessing it:

- 429 compute CU-seconds;
- 0.057834796 organization storage GiB-hours;
- 0.031670173 project storage GiB-hours; and
- 246,385.080000000 queue byte-seconds.

The old book charged 19,350 micro-USD of usage plus 2,322 of 12% overhead: 21,672 total. Under the
settled policy, the same grains are 12,632 compute, 30 and 17 storage, and 1 queue micro-USD. Compute
gets 253 micro-USD of 2% overhead, storage gets zero, and the queue's unchanged 12% policy rounds
to 1 micro-USD. The correct total is 12,934 micro-USD, so the exact PostgreSQL correction is
**8,738 micro-USD**.

After this audit, that correction was posted exactly once as append-only adjustment transaction
`01a04825-4db9-7777-b103-fce913782cf3`. Its idempotency key is
`adjustment:postgres-v1-policy:01a045b4-13a3-75bc-b707-4547b486534f`, and its
`credit_transaction` reference points to the original 21,672-micro-USD usage transaction. Its two
ledger legs are +8,738 micro-USD to `user_credit` and -8,738 micro-USD to `platform_revenue`.

A follow-up read-only production audit found exactly one transaction with that key. The current
operation is therefore a no-op: do not post another adjustment. Any future operator must check the
exact idempotency key first; the ledger's `post()` path returns the existing transaction rather
than creating another one. If this correction itself ever needs reversing, add a separately keyed,
balanced counter-transaction instead of editing or deleting either immutable entry.

## The check that matters

A reconciliation must be reproducible from three independent facts:

1. user-credit postings in `credit_ledger_entry`, grouped through `credit_transaction`;
2. deduplicated `usage_event_raw FINAL` quantities and their external-charge marker; and
3. hourly `usage_rollup` watermarks rated with the applicable price-book item and fee override.

Comparing a dashboard total with a provider invoice is useful triage. It is not enough to authorize
a ledger entry, because neither side explains BYO attribution, price-book activation, or an earlier
compensating transaction.
