# 0064 — Statements had no writer

## What was missing

The initial schema created `statement` and `statement_line_item`, the API listed statement headers,
and `renderInvoicePdf` could construct valid PDF bytes. None of those pieces had a production
caller. The only statement insert was a route test, no job closed a month, the dashboard printed a
UUID as the invoice number, and no endpoint returned statement detail or a PDF.

That was not an optional reporting enhancement. The original billing plan requires monthly
explicable statements, a detail endpoint, billing-history UI, PDF invoices, and the invariant that
the total equals its line items plus the separately visible platform fee. The later datastore audit
in `/Users/andrew/.claude/plans/double-sorted-meteor.md` called out the missing writer and PDF caller
explicitly and required the launch plan either to build them or exclude customer statements. The
product plan never excluded them.

## Why a month-end query over usage was not enough

`usage_rollup` is the durable quantity projection, not an immutable record of the money collected.
The charger caps a delayed debit at available prepaid credit, externally paid quantities are
excluded, and late usage can update a grain after an earlier transaction. Re-rating a month at
statement time can therefore disagree with the append-only ledger even when both systems are
working correctly.

New usage charges now write their statement association and attributed detail in the same database
transaction as the balanced ledger posting. `statement_charge.credit_transaction_id` is unique, so
a retry cannot add the same debit twice. Line items aggregate by statement, kind, project, and
dimension, and the database enforces `total_micro_usd = subtotal_micro_usd + overhead_micro_usd`.

The daily `billing.generate_statements` job has two jobs:

1. create and finalize the just-closed UTC month, including an honest zero-usage statement; and
2. associate exact older usage debits that predate the new link.

For those older debits, it preserves the exact usage/platform-fee split from the ledger postings but
does not manufacture project or dimension attribution the old transaction did not retain. The PDF
and dashboard say that this is generic metered usage.

## Customer surface

The list returns a stable human invoice number rather than exposing the UUID as the number. A detail
route returns the rows that reconcile to the total, and an authenticated PDF route renders the same
data with Ur LLC's billing address. PDFs are private, non-cacheable downloads and paginate when a
statement has more lines than one letter page can hold.

The document shows exact micro-USD. SproutOS already debited prepaid credit in micro-USD; rounding a
statement total up to cents would make the PDF disagree with both the ledger and its own lines.

## Legacy context and evidence boundary

This resolution keeps the earlier reporting record rather than rewriting it:

- `private_notes/groups.md` is the original grouped implementation/reporting record.
- `private_notes/ADDITIONS_1.md` carries the later launch additions.
- `private_notes/sandbox-handoff.md` distinguishes Docker evidence from Daytona evidence.
- `/Users/andrew/.claude/plans/read-the-readme-md-to-eventual-dusk.md` records the original product
  rollout and its verification boundaries.
- `/Users/andrew/.claude/plans/double-sorted-meteor.md` is the audit that identified the missing
  statement writer and unused PDF renderer.

This finding describes code and isolated local Postgres verification. It does not claim that the PR
has been merged, deployed, that a production statement has been generated, or that an invoice was
sent externally.
