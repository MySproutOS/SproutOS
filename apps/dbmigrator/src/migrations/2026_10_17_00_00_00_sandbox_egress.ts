import { sql, type Kysely } from "kysely"
import { randomBytes } from "node:crypto"

const DIMENSION = "sandbox_egress_byte"
const UNIT_MICRO_USD = "0.00009"

// Migration files are loaded directly by Kysely's native-ESM FileMigrationProvider. Keep this
// self-contained: a relative helper import works under tsx but fails during the real deploy path.
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

const ACTIVE_DIMENSIONS = [
  "site_gib_second",
  "site_provisioned_gib_second",
  "site_request",
  "site_egress_byte",
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
  DIMENSION,
]
const RETIRED_DIMENSIONS = [
  "site_vcpu_second",
  "site_active_cpu_second",
  "site_ws_connection_second",
]

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
 * Price the two public AWS DTO legs created by Daytona's authenticated forward proxy.
 *
 * EC2 US-East's published first transfer tier is $0.09/decimal-GB: 90,000 micro-USD divided by
 * 1,000,000,000 bytes. Account-level promotions and aggregate free tiers are not allocated to one
 * tenant, matching the provider-list-rate policy for the other dimensions. The item-level zero
 * overhead makes the zero SproutOS fee explicit.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await dimensions(db, "price_book_item", ACTIVE_DIMENSIONS)
  await Promise.all(
    ["usage_rollup", "statement_line_item"].map((table) =>
      dimensions(db, table, [...ACTIVE_DIMENSIONS, ...RETIRED_DIMENSIONS]),
    ),
  )

  const book = await db
    .selectFrom("price_book")
    .select("id")
    .where("version", "=", 2)
    .executeTakeFirst()
  // Fresh databases run migrations before seeds; the v2 seed creates this row in that case.
  if (book === undefined) return
  await db
    .insertInto("price_book_item")
    .values({
      id: uuidV7(),
      price_book_id: book.id,
      dimension: DIMENSION,
      unit_micro_usd: UNIT_MICRO_USD,
      included_free_quantity: "0",
      overhead_bps: 0,
      rounding: "half_even",
    })
    .onConflict((conflict) => conflict.columns(["price_book_id", "dimension"]).doNothing())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  const stranded = await Promise.all(
    ["usage_rollup", "statement_line_item"].map(async (table) => {
      const result = await sql<{ count: string }>`
      select count(*)::text as count
        from ${sql.table(table)}
       where dimension = ${DIMENSION}
      `.execute(db)
      return { table, count: Number(result.rows[0]?.count ?? "0") }
    }),
  )
  for (const { table, count } of stranded) {
    if (count > 0) {
      throw new Error(
        `${table} contains ${DIMENSION} history; deleting it would break statement reconciliation`,
      )
    }
  }
  await db.deleteFrom("price_book_item").where("dimension", "=", DIMENSION).execute()
  const previous = ACTIVE_DIMENSIONS.filter((dimension) => dimension !== DIMENSION)
  await dimensions(db, "price_book_item", previous)
  await Promise.all(
    ["usage_rollup", "statement_line_item"].map((table) =>
      dimensions(db, table, [...previous, ...RETIRED_DIMENSIONS]),
    ),
  )
}
