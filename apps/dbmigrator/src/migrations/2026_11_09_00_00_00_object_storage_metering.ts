import { sql, type Kysely } from "kysely"
import { randomBytes } from "node:crypto"

const ADDED = new Map([
  ["object_storage_write_request", "5"],
  ["object_storage_read_request", "0.4"],
  ["object_storage_egress_byte", "0.00009"],
  ["object_storage_gb_month", "23000"],
])

const ACTIVE_DIMENSIONS = [
  "site_gib_second",
  "site_provisioned_gib_second",
  "site_request",
  "site_egress_byte",
  ...ADDED.keys(),
  "db_storage_gib_hour",
  "db_storage_gb_month",
  "db_history_storage_gb_month",
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
  "ai_cache_write_token",
  "ai_long_context_input_token",
  "ai_long_context_output_token",
  "ai_long_context_cache_read_token",
  "ai_long_context_cache_write_token",
  "agent_run_second",
  "sandbox_cpu_second",
  "sandbox_gib_second",
  "sandbox_disk_gib_second",
  "sandbox_egress_byte",
]
const RETIRED_DIMENSIONS = [
  "site_vcpu_second",
  "site_active_cpu_second",
  "site_ws_connection_second",
]

function uuidV7(): string {
  const bytes = randomBytes(16)
  const timestamp = BigInt(Date.now())
  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

function list(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ")
}

async function dimensions(db: Kysely<unknown>, table: string, values: string[]): Promise<void> {
  await sql`
    alter table ${sql.table(table)} drop constraint if exists ${sql.raw(`${table}_dimension_check`)}
  `.execute(db)
  await sql`
    alter table ${sql.table(table)} add constraint ${sql.raw(`${table}_dimension_check`)}
    check (dimension in (${sql.raw(list(values))}))
  `.execute(db)
}

/**
 * Price mutable S3 storage at AWS's public us-east-1 Standard rates, with no SproutOS markup.
 *
 * PUT/COPY/POST/LIST are $0.005/1,000, GET and other reads are $0.0004/1,000, transfer is
 * $0.09/decimal-GB, and storage is $0.023/decimal-GB-month. DELETE remains unmetered because the
 * provider does not charge for it. Static-site delivery has its own dimensions and is not included.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("object_storage_metering_state")
    .addColumn("backend_service_id", "uuid", (col) =>
      col.primaryKey().references("backend_service.id").onDelete("cascade"),
    )
    .addColumn("current_bytes", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("metered_through", "timestamptz")
    .addColumn("measured_at", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex("object_storage_metering_state_metered_through_idx")
    .on("object_storage_metering_state")
    .column("metered_through")
    .execute()

  /*
    The service cutoff and the destructive retention deadline are one durable fact.

    `reserve_micro_usd` is a protected balance floor, not a debit and not a second storage charge.
    It is the estimated price of retaining the organization's latest measured object bytes for
    another forty-eight hours. When spendable credit reaches that floor, new service work stops and
    `delete_after` records the end of the already-funded retention window. A later top-up clears
    both timestamps; any eventual destructive worker must re-read the balance immediately before
    deleting, as `decideReprieve` requires.
  */
  await db.schema
    .createTable("credit_retention_state")
    .addColumn("organization_id", "uuid", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("reserve_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("exhausted_at", "timestamptz")
    .addColumn("delete_after", "timestamptz")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "credit_retention_deadline_pair_check",
      sql`(exhausted_at is null) = (delete_after is null)`,
    )
    .execute()
  await db.schema
    .createIndex("credit_retention_state_delete_after_idx")
    .on("credit_retention_state")
    .column("delete_after")
    .where("delete_after", "is not", null)
    .execute()

  await dimensions(db, "price_book_item", ACTIVE_DIMENSIONS)
  await Promise.all(
    ["usage_rollup", "statement_line_item"].map((table) =>
      dimensions(db, table, [...ACTIVE_DIMENSIONS, ...RETIRED_DIMENSIONS]),
    ),
  )

  const book = await sql<{
    id: string
  }>`select id::text as id from price_book where version = 2`.execute(db)
  const bookId = book.rows[0]?.id
  if (bookId === undefined) return

  await db
    .insertInto("price_book_item")
    .values(
      [...ADDED].map(([dimension, unitMicroUsd]) => ({
        id: uuidV7(),
        price_book_id: bookId,
        dimension,
        unit_micro_usd: unitMicroUsd,
        included_free_quantity: "0",
        overhead_bps: 0,
        rounding: "half_even",
      })),
    )
    .onConflict((conflict) => conflict.columns(["price_book_id", "dimension"]).doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ["usage_rollup", "statement_line_item"]) {
    const result = await sql<{ count: string }>`
      select count(*)::text as count
        from ${sql.table(table)}
       where dimension in (${sql.join([...ADDED.keys()])})
    `.execute(db)
    if (Number(result.rows[0]?.count ?? "0") > 0) {
      throw new Error(`${table} contains object-storage billing history; downgrade is unsafe`)
    }
  }

  await db
    .deleteFrom("price_book_item")
    .where("dimension", "in", [...ADDED.keys()])
    .execute()
  const previous = ACTIVE_DIMENSIONS.filter((dimension) => !ADDED.has(dimension))
  await dimensions(db, "price_book_item", previous)
  await Promise.all(
    ["usage_rollup", "statement_line_item"].map((table) =>
      dimensions(db, table, [...previous, ...RETIRED_DIMENSIONS]),
    ),
  )
  await db.schema.dropTable("credit_retention_state").execute()
  await db.schema.dropTable("object_storage_metering_state").execute()
}
