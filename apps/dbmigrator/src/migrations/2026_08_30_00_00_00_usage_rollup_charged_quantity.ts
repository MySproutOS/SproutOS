import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Record how much of a grain has been charged, not merely that it was.
 *
 * `usage_rollup.rated_transaction_id` was the only marker: null meant uncharged, set meant charged,
 * and the charge job claimed rows where it was null. That is correct exactly once per grain, and
 * usage does not arrive exactly once.
 *
 * `rollUpUsage` upserts — a late event lands in the grain it belongs to and adds to that row's
 * quantity. The metering agent has a retry buffer for precisely this case, so an event delayed past
 * the rollup's five-minute grace by a network partition or a restart is normal rather than
 * exceptional. When that lands in an hour that has already been charged, the row's quantity goes up
 * and its `rated_transaction_id` stays set, so the charge job never looks at it again.
 *
 * The extra usage is free. Nothing errors, nothing is logged, and the arithmetic everywhere agrees
 * with itself — the only wrong number is the one the customer pays.
 *
 * Clearing `rated_transaction_id` on upsert would be worse: the grain would then be charged from
 * zero a second time, billing the part already paid for twice.
 *
 * So the row records the quantity that has been charged. The claim becomes
 * `quantity > charged_quantity` and the charge is the difference — right the first time, right for
 * a late arrival, and right for a grain that arrives in four instalments.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table usage_rollup
      add column charged_quantity numeric(38,9) not null default 0
  `.execute(db)

  /*
    Existing charged rows are treated as charged in full.

    They were, under the old rule — the whole quantity at the time was billed. Backfilling from
    `quantity` rather than leaving zero is what stops this migration re-charging every grain the
    platform has ever billed.
  */
  await sql`
    update usage_rollup set charged_quantity = quantity where rated_transaction_id is not null
  `.execute(db)

  /*
    The index the charge job scans.

    Partial on the charged bucket, because that is the only grain that is ever charged — minute and
    day are other views of the same events. Without this the job sequentially scans every rollup
    the platform has ever written to find the few that owe something.
  */
  await sql`
    create index usage_rollup_chargeable_idx
      on usage_rollup (bucket_start)
      where bucket = 'hour' and quantity > charged_quantity
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists usage_rollup_chargeable_idx`.execute(db)
  await sql`alter table usage_rollup drop column charged_quantity`.execute(db)
}
