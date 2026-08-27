import { sql, type Kysely } from "kysely"

/**
 * The durable cursor for Neon's invoice-aligned consumption history.
 *
 * An outbox event and this watermark advance in the same transaction. A worker crash therefore
 * leaves either both committed or neither committed, and a retry asks Neon for the same closed
 * hourly window instead of inventing a delta from a process-local counter.
 *
 * WebSocket time is unpriced here too. The router strips `Upgrade` and cannot carry a WebSocket,
 * so the seeded rate described a product the platform does not provide and no writer can observe.
 * Historical rollup constraints remain readable, but the active event vocabulary and new price
 * books no longer advertise it, and existing books lose the unused rate.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("neon_metering_state")
    .addColumn("backend_service_id", "uuid", (col) =>
      col.primaryKey().references("backend_service.id").onDelete("cascade"),
    )
    .addColumn("metered_through", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex("neon_metering_state_metered_through_idx")
    .on("neon_metering_state")
    .column("metered_through")
    .execute()

  await sql`
    delete from price_book_item where dimension = 'site_ws_connection_second'
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Do not recreate an unsupported rate on rollback. Price rows are configuration, not usage, and
  // the old value would resume advertising a meter whose transport still does not exist.
  await db.schema.dropTable("neon_metering_state").execute()
}
