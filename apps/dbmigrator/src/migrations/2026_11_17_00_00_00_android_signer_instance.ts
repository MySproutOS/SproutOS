import { type Kysely, sql } from "kysely"

/** Durable fleet heartbeat for the outbound-only Android signer. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("android_signer_instance")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("signer_id", "text", (col) => col.notNull().unique())
    .addColumn("last_seen_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "android_signer_instance_signer_id_check",
      sql`length(signer_id) between 1 and 200`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("android_signer_instance").execute()
}
