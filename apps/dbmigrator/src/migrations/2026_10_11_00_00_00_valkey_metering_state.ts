import { sql, type Kysely } from "kysely"

/**
 * The two observations required to estimate tenant queue residency.
 *
 * A point-in-time `MEMORY USAGE` sum is not itself byte-seconds. Keeping the last successful
 * observation lets the sampler integrate only intervals it actually bracketed. The row and its
 * metering outbox event advance in one transaction, so a crash cannot bill an interval twice or
 * advance past usage that was never made durable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("valkey_metering_state")
    .addColumn("backend_service_id", "uuid", (col) =>
      col.primaryKey().references("backend_service.id").onDelete("cascade"),
    )
    .addColumn("sampled_at", "timestamptz", (col) => col.notNull())
    .addColumn("memory_bytes", "bigint", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("valkey_metering_state_memory_bytes_check", sql`memory_bytes >= 0`)
    .execute()

  await db.schema
    .createIndex("valkey_metering_state_sampled_at_idx")
    .on("valkey_metering_state")
    .column("sampled_at")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("valkey_metering_state").execute()
}
