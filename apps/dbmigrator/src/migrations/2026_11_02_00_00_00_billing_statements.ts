import { type Kysely, sql } from "kysely"

/**
 * Tie every customer statement back to the immutable ledger transactions it explains.
 *
 * `statement_line_item` existed from the initial schema, but nothing could prove which debit a
 * line represented. A retrying monthly job therefore had only two bad choices: duplicate a line,
 * or guess that a similar-looking row was the same charge. The association below makes the ledger
 * transaction the idempotency key and keeps line items aggregated to one readable row per
 * project/dimension.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("statement_charge")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("statement_id", "uuid", (col) =>
      col.references("statement.id").onDelete("cascade").notNull(),
    )
    .addColumn("credit_transaction_id", "uuid", (col) =>
      col.references("credit_transaction.id").onDelete("restrict").notNull().unique(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex("statement_charge_statement_id_idx")
    .on("statement_charge")
    .column("statement_id")
    .execute()

  await sql`
    create unique index statement_line_item_scope_key
      on statement_line_item (statement_id, kind, project_id, dimension) nulls not distinct
  `.execute(db)

  await sql`
    alter table statement add constraint statement_period_check check (period_end > period_start)
  `.execute(db)
  await sql`
    alter table statement add constraint statement_totals_check check (
      subtotal_micro_usd >= 0
      and overhead_micro_usd >= 0
      and total_micro_usd = subtotal_micro_usd + overhead_micro_usd
    )
  `.execute(db)
  await sql`
    alter table statement_line_item add constraint statement_line_item_amount_check
      check (amount_micro_usd >= 0)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table statement_line_item drop constraint statement_line_item_amount_check
  `.execute(db)
  await sql`alter table statement drop constraint statement_totals_check`.execute(db)
  await sql`alter table statement drop constraint statement_period_check`.execute(db)
  await db.schema.dropIndex("statement_line_item_scope_key").execute()
  await db.schema.dropTable("statement_charge").execute()
}
