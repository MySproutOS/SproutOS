import { type Kysely, sql } from "kysely"

/**
 * Bill compute the way Lambda bills it.
 *
 * Two dimensions described a model this platform does not use:
 *
 * - `site_active_cpu_second` — billing only the time a request was *using* CPU and discounting the
 *   time it spent waiting on a database. That is Vercel Fluid's model. Lambda does not work that
 *   way and neither does the bill AWS sends us, so charging for it would have meant a customer
 *   paying less than the invocation cost us on every IO-bound request.
 * - `site_vcpu_second` — vCPU metered separately from memory. Lambda has no such knob: CPU is
 *   allocated in proportion to configured memory, and the only unit that exists is the GB-second.
 *
 * What is left is what AWS actually charges: **GB-seconds of billed duration, plus a per-request
 * fee.** `site_gib_second` and `site_request` were already the right dimensions; they are now the
 * only compute ones, so there is no second place for a rating job to look.
 *
 * `site_provisioned_gib_second` stays. Provisioned concurrency is a real Lambda charge, billed per
 * GB-hour for as long as it is configured whether or not anything is invoked, and a platform that
 * offers a warm instance has to be able to charge for one.
 */
const RETIRED = ["site_vcpu_second", "site_active_cpu_second"]

const KEPT = [
  "site_gib_second",
  "site_provisioned_gib_second",
  "site_request",
  "site_egress_byte",
  "site_ws_connection_second",
  "db_storage_gib_hour",
  "db_compute_cu_second",
  "es_storage_gib_hour",
  "es_search_unit",
  "valkey_queue_byte_second",
  "workflow_job_enqueued",
  "workflow_exec_vcpu_second",
  "workflow_exec_gib_second",
  "ai_input_token",
  "ai_output_token",
  "ai_cache_read_token",
  "agent_run_second",
]

function list(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ")
}

export async function up(db: Kysely<unknown>): Promise<void> {
  /*
    Refuse rather than delete.

    A `usage_event` on a retired dimension is money somebody was charged, and a migration that
    quietly dropped those rows would make a statement stop reconciling with no record of why. In
    development there are none and this passes; anywhere there are, the deploy stops and a person
    decides what the right conversion is.
  */
  const stranded = await sql<{
    count: string
  }>`select count(*)::text as count from usage_event where dimension in (${sql.raw(list(RETIRED))})`.execute(
    db,
  )

  const count = Number(stranded.rows[0]?.count ?? "0")
  if (count > 0) {
    throw new Error(
      `${count} usage_event row(s) are on a retired compute dimension (${RETIRED.join(", ")}). ` +
        `These were billed under a model this platform no longer uses. Convert or archive them ` +
        `before applying this migration; deleting them silently would break statement reconciliation.`,
    )
  }

  await sql`alter table usage_event drop constraint if exists usage_event_dimension_check`.execute(
    db,
  )
  await sql`
    alter table usage_event add constraint usage_event_dimension_check
      check (dimension in (${sql.raw(list(KEPT))}))
  `.execute(db)

  /*
    The price rows go before the constraint that would reject them.

    Written the other way round first, which failed with "check constraint is violated by some row"
    — the same shape as every constraint-before-cleanup bug, and the reason the order is worth a
    comment rather than looking arbitrary.

    Safe to delete, unlike the usage events above: a price is a rate, not a charge. Nothing
    reconciles against it after the events it rated have been rated.
  */
  await sql`delete from price_book_item where dimension in (${sql.raw(list(RETIRED))})`.execute(db)

  await sql`alter table price_book_item drop constraint if exists price_book_item_dimension_check`.execute(
    db,
  )
  await sql`
    alter table price_book_item add constraint price_book_item_dimension_check
      check (dimension in (${sql.raw(list(KEPT))}))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const all = list([...KEPT, ...RETIRED])

  await sql`alter table usage_event drop constraint if exists usage_event_dimension_check`.execute(
    db,
  )
  await sql`
    alter table usage_event add constraint usage_event_dimension_check
      check (dimension in (${sql.raw(all)}))
  `.execute(db)

  await sql`alter table price_book_item drop constraint if exists price_book_item_dimension_check`.execute(
    db,
  )
  await sql`
    alter table price_book_item add constraint price_book_item_dimension_check
      check (dimension in (${sql.raw(all)}))
  `.execute(db)
}
