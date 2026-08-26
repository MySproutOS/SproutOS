import { sql, type Kysely } from "kysely"

/**
 * The small Postgres half of the ClickHouse metering cutover.
 *
 * Raw usage belongs in Kafka and ClickHouse. Postgres still owns two facts that need transactions:
 * an event a TypeScript workflow has committed but not yet published, and how much of an imported
 * rollup has already been settled outside the ordinary charge job. Neither table is a second raw
 * event store: delivered outbox rows are deleted, and the import cursor is one row per consumer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("metering_outbox")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("event_id", "text", (col) => col.notNull().unique())
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex("metering_outbox_created_idx")
    .on("metering_outbox")
    .column("created_at")
    .execute()

  await db.schema
    .createTable("metering_import_state")
    .addColumn("consumer", "text", (col) => col.primaryKey())
    .addColumn("cursor", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  /*
    `charged_quantity` mixes two reasons a quantity is already paid: the ordinary charge job and
    an external settlement such as an agent hold. The importer needs the second subtotal so a new
    absolute ClickHouse total can add only the newly externally-settled delta. Using
    greatest(charged_quantity, external_total) would erase that distinction and undercharge a grain
    containing both kinds.
  */
  await sql`
    alter table usage_rollup
      add column externally_charged_quantity numeric(38, 9) not null default 0
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const pending = await sql<{ count: string }>`
    select count(*)::text as count from metering_outbox
  `.execute(db)
  if (Number(pending.rows[0]?.count ?? "0") > 0) {
    throw new Error(
      `${pending.rows[0]?.count} metering outbox row(s) have not been published; ` +
        "drain them before removing the ClickHouse cutover state.",
    )
  }

  await sql`alter table usage_rollup drop column externally_charged_quantity`.execute(db)
  await db.schema.dropTable("metering_import_state").execute()
  await db.schema.dropTable("metering_outbox").execute()
}
