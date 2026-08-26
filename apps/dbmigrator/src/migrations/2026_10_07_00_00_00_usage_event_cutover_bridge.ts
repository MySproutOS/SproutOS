import { sql, type Kysely } from "kysely"

/**
 * Keep raw metering alive while it moves out of Postgres.
 *
 * `usage_event` was created with eight daily partitions and no process that creates another one.
 * The last child therefore becomes a hard expiry date: the next insert fails with "no partition of
 * relation usage_event found for row". That is not a retention policy; it is the whole billing
 * ingest turning off at midnight.
 *
 * A permanent partition scheduler would preserve the wrong storage model. Raw usage belongs in
 * ClickHouse, where parts are created as data arrives and TTL removes them. This DEFAULT partition
 * is deliberately a bridge: it removes the calendar cliff while the ClickHouse dual-write,
 * backfill and reconciliation land. The migration that drops `usage_event` drops it with the
 * parent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table if not exists usage_event_cutover_default
      partition of usage_event default
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from usage_event_cutover_default
  `.execute(db)

  const count = Number(rows.rows[0]?.count ?? "0")
  if (count > 0) {
    throw new Error(
      `${count} usage event(s) landed after the pre-created partition window. ` +
        "Backfill them into ClickHouse before removing the cutover bridge.",
    )
  }

  await sql`drop table if exists usage_event_cutover_default`.execute(db)
}
