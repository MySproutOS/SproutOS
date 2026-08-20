# @lib/billing

The credit ledger: append-only double-entry accounting, holds, and the Stripe top-up path.

## Money is `bigint` micro-USD

One millionth of a dollar. Never a float, never a decimal string a caller will parse with `Number`.

**Unit rates are the exception.** A cache-read token costs 0.33 micro-USD and egress costs 0.00014, so
a rate held as an integer would floor to **zero** and the dimension would bill nothing, forever. Rates
live in `price_book_item.unit_micro_usd` as `numeric(38,9)` and are multiplied in bigint by
`rateTimesQuantity`. Amounts are integers; rates are not.

## Every movement is a balanced transaction

A `credit_transaction` with `credit_ledger_entry` postings that **sum to zero**. Positive increases an
account, negative decreases it.

A $10 top-up:

| account            | micro-USD   |
| ------------------ | ----------- |
| `stripe_clearing`  | −10,000,000 |
| `user_credit`      | +9,410,000  |
| `platform_revenue` | +590,000    |

The database enforces the balance itself, with a deferred constraint trigger, and a second trigger
makes entries append-only — the only column that may ever change is `compacted_at`, once, from null.
`post()` checks the sum too, but only so the failure is a typed error at the call site instead of an
opaque constraint violation at commit.

**There is no `balance` column.** There never will be. Balance is the sum of postings.

## The processing fee

TASK 7 fixes the minimum top-up at $0.50. Stripe takes 2.9% + $0.30, which is **$0.3145 of that
$0.50 — 63%**. Crediting the full amount would lose money on every small payment.

So the fee is charged and **shown as its own line**, rather than hidden in a balance smaller than the
amount paid:

| charged | fee     | credited | fee as % |
| ------- | ------- | -------- | -------- |
| $0.50   | $0.3145 | $0.1855  | 62.9%    |
| $5.00   | $0.4450 | $4.5550  | 8.9%     |
| $10.00  | $0.5900 | $9.4100  | 5.9%     |
| $100.00 | $3.2000 | $96.8000 | 3.2%     |

The markup over Stripe's own rate is **zero** — this is a pass-through, not a margin. Stripe's rate is
hard-coded because the fee has to be quoted before the charge exists; if it changes, `money.ts` is the
one place to edit.

## Overhead

TASK 28's amortized platform overhead is `price_book.overhead_bps` (currently 1200, so 12%), applied
to metered usage and posted as **its own ledger entry**. A statement can then show what the resources
cost and what the platform added, and the two add up to the total. Folding it into the usage figure
would make a bill unexplainable.

## Rounding

Every fee and overhead calculation rounds **up**. Rounding down means eating the remainder on every
single transaction, and at the volumes this product is designed for that is not a rounding error, it
is a revenue leak.

## Balance and the compaction checkpoint

`availableBalance` reads the cached checkpoint and adds the uncompacted tail, minus active holds.

The checkpoint is `credit_ledger_entry.compacted_at` — **commit-ordered, not an identity sequence**.
A sequence allocates its number at INSERT, not at COMMIT, so a transaction that takes number 100 and
commits after one that took 101 is skipped permanently once the compactor advances past 101. That is
under-counting spend, which loses money silently.

## Spending cannot overdraw

`spend()` locks the account row, reads the balance, and posts in one transaction. Two concurrent
spends that each read the same balance outside a lock would both pass their check and together
overdraw it.

## Only the webhook credits

`begin()` writes the `topup` row _before_ the PaymentIntent exists, so a crash between the two leaves
a `pending` row to reconcile rather than a charge with nothing pointing at it. Nothing is credited
there — only `settle()` credits, because only the webhook knows the money actually moved.

Idempotency is doubled up: Stripe deduplicates on `topup:{id}` so a retried request reuses the intent
instead of charging twice, and the ledger deduplicates on `stripe:pi:{intentId}` so a redelivered
webhook posts nothing the second time.

## Testing

`ledger.test.ts` runs against the docker-compose Postgres, deliberately. The invariants that matter —
the balanced-transaction trigger and the append-only guard — live in the database and are not
reimplemented in TypeScript, so testing against a fake would test nothing worth testing. It asserts
that a hand-written unbalanced posting is refused even when it bypasses `post()`.

Its teardown uses `set local session_replication_role = 'replica'`, the same privileged purge path
retention and GDPR deletion need. That cleanup is awkward is the point: the ledger is not supposed to
be easy to erase.
