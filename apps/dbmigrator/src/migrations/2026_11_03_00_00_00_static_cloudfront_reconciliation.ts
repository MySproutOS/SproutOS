import { sql, type Kysely } from "kysely"

/**
 * Keep provider-vs-ledger reconciliation durable without manufacturing tenant usage.
 *
 * CloudFront standard logs are best effort and can arrive a day late. The provider's aggregate
 * request count is therefore compared with deduplicated ClickHouse request events for each closed
 * UTC day. Byte totals are deliberately absent: CloudWatch BytesDownloaded and standard-log
 * sc-bytes have different documented boundaries. A positive request residual is an operational
 * platform-overhead fact, never a usage event.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("provider_usage_reconciliation")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("resource_id", "text", (col) => col.notNull())
    .addColumn("period_start", "timestamptz", (col) => col.notNull())
    .addColumn("provider_requests", "numeric(38, 9)", (col) => col.notNull())
    .addColumn("imported_requests", "numeric(38, 9)", (col) => col.notNull())
    .addColumn("residual_requests", "numeric(38, 9)", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("observed_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("provider_usage_reconciliation_source_period_unique", [
      "provider",
      "resource_id",
      "period_start",
    ])
    .addCheckConstraint(
      "provider_usage_reconciliation_status_check",
      sql`status in ('matched', 'pending_delivery', 'platform_overhead')`,
    )
    .addCheckConstraint(
      "provider_usage_reconciliation_quantities_nonnegative",
      sql`provider_requests >= 0 and imported_requests >= 0 and residual_requests >= 0`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("provider_usage_reconciliation").execute()
}
