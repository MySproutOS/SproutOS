import { sql, type Kysely } from "kysely"

/**
 * Finish the raw-usage cutover from Postgres to Kafka and ClickHouse.
 *
 * The ClickHouse importer now writes absolute totals into `usage_rollup`, and every control-plane
 * producer commits through `metering_outbox`. Keeping the old raw table and its dormant rollup job
 * would leave a second authority that can expire, diverge, or be accidentally restarted.
 *
 * Queued jobs are cancelled first so an old worker cannot claim work whose input table no longer
 * exists. Production contains no billing history that needs moving; the raw ClickHouse stream is
 * the only source retained by this cutover.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update background_job
       set state = 'cancelled',
           finished_at = now(),
           last_error = 'cancelled: Postgres usage_event rollup was retired',
           updated_at = now()
     where kind = 'billing.roll_up_usage'
       and state in ('queued', 'leased', 'running')
  `.execute(db)

  await db.schema.dropTable("usage_event").execute()
}

export function down(_db: Kysely<unknown>): Promise<void> {
  return Promise.reject(
    new Error(
      "usage_event is retired and its raw rows were intentionally not migrated; restore from a pre-cutover backup instead",
    ),
  )
}
