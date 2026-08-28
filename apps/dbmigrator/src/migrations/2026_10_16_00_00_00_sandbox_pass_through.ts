import { sql, type Kysely } from "kysely"
import { randomBytes } from "node:crypto"

type MigrationDB = {
  priceBook: {
    id: string
    version: number
    name: string
    currency: string
    overheadBps: number
    effectiveAt: Date
  }
  priceBookItem: {
    id: string
    priceBookId: string
    dimension: string
    unitMicroUsd: string
    includedFreeQuantity: string
    rounding: string
    overheadBps: number | null
  }
}

const VERSION = 2

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
const ADDED_RATES = new Map([
  ["db_storage_gb_month", "350000"],
  ["db_history_storage_gb_month", "200000"],
  ["ai_cache_write_token", "2.5"],
  ["ai_long_context_input_token", "4"],
  ["ai_long_context_output_token", "18"],
  ["ai_long_context_cache_read_token", "0.4"],
  ["ai_long_context_cache_write_token", "5"],
])
const PASS_THROUGH_RATES = new Map([
  ["db_compute_cu_second", "29.444444444"],
  ["db_storage_gib_hour", "514.807723836"],
  ["ai_input_token", "2"],
  ["ai_output_token", "12"],
  ["ai_cache_read_token", "0.2"],
  ...ADDED_RATES,
  ["sandbox_cpu_second", "14"],
  ["sandbox_gib_second", "4.5"],
  ["sandbox_disk_gib_second", "0.03"],
  ["agent_run_second", "0"],
])

const OVERHEAD_BPS = new Map([
  ["db_compute_cu_second", 200],
  ["db_storage_gib_hour", 0],
  ["db_storage_gb_month", 0],
  ["db_history_storage_gb_month", 0],
  ["ai_input_token", 0],
  ["ai_output_token", 0],
  ["ai_cache_read_token", 0],
  ...[...ADDED_RATES.keys()].map((dimension) => [dimension, 0] as [string, number]),
  ["sandbox_cpu_second", 0],
  ["sandbox_gib_second", 0],
  ["sandbox_disk_gib_second", 0],
  ["agent_run_second", 0],
])

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
  ...ADDED_RATES.keys(),
  "agent_run_second",
  "sandbox_cpu_second",
  "sandbox_gib_second",
  "sandbox_disk_gib_second",
]
const RETIRED_DIMENSIONS = [
  "site_vcpu_second",
  "site_active_cpu_second",
  "site_ws_connection_second",
]

function list(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ")
}

async function dimensions(db: Kysely<any>, table: string, values: string[]): Promise<void> {
  await sql`
    alter table ${sql.table(table)} drop constraint if exists ${sql.raw(`${table}_dimension_check`)}
  `.execute(db)
  await sql`
    alter table ${sql.table(table)} add constraint ${sql.raw(`${table}_dimension_check`)}
    check (dimension in (${sql.raw(list(values))}))
  `.execute(db)
}

/** Pass provider-priced AI and sandbox usage through without changing any other dimension. */
export async function up(db: Kysely<MigrationDB>): Promise<void> {
  const effectiveAt = new Date()
  await db.schema.alterTable("price_book_item").addColumn("overhead_bps", "integer").execute()
  await sql`
    alter table price_book_item
    add constraint price_book_item_overhead_bps_check
    check (overhead_bps is null or overhead_bps between 0 and 100000)
  `.execute(db)
  await dimensions(db, "price_book_item", ACTIVE_DIMENSIONS)
  for (const table of ["usage_rollup", "statement_line_item"]) {
    await dimensions(db, table, [...ACTIVE_DIMENSIONS, ...RETIRED_DIMENSIONS])
  }

  const source = await db
    .selectFrom("priceBook")
    .select(["id", "currency", "overheadBps"])
    .where("version", "<", VERSION)
    .where("effectiveAt", "<=", effectiveAt)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  // On a fresh database migrations precede seeds. The v2 seed below creates the whole book.
  if (source === undefined) return

  const existing = await db
    .selectFrom("priceBook")
    .select("id")
    .where("version", "=", VERSION)
    .executeTakeFirst()
  const priceBookId = existing?.id ?? uuidV7()
  if (existing === undefined) {
    await db
      .insertInto("priceBook")
      .values({
        id: priceBookId,
        version: VERSION,
        name: "Launch provider pass-through",
        currency: source.currency,
        overheadBps: source.overheadBps,
        // Existing usage remains reconstructible against v1; v2 takes effect at deployment.
        effectiveAt,
      })
      .execute()
  } else {
    // A seed may have created the version row before this schema migration was deployed. Repair
    // that partial deployment in place and make the new policy effective at migration time.
    await db
      .updateTable("priceBook")
      .set({
        name: "Launch provider pass-through",
        currency: source.currency,
        overheadBps: source.overheadBps,
        effectiveAt,
      })
      .where("id", "=", priceBookId)
      .execute()
  }

  const items = await db
    .selectFrom("priceBookItem")
    .select(["dimension", "unitMicroUsd", "includedFreeQuantity", "rounding"])
    .where("priceBookId", "=", source.id)
    .execute()

  const rows = items.map((item) => ({
    id: uuidV7(),
    priceBookId,
    dimension: item.dimension,
    unitMicroUsd: PASS_THROUGH_RATES.get(item.dimension) ?? item.unitMicroUsd,
    includedFreeQuantity: item.includedFreeQuantity,
    rounding: item.rounding,
    overheadBps: OVERHEAD_BPS.get(item.dimension) ?? null,
  }))
  for (const [dimension, rate] of ADDED_RATES) {
    if (items.some((item) => item.dimension === dimension)) continue
    rows.push({
      id: uuidV7(),
      priceBookId,
      dimension,
      unitMicroUsd: rate,
      includedFreeQuantity: "0",
      rounding: "half_even",
      overheadBps: 0,
    })
  }
  await db
    .insertInto("priceBookItem")
    .values(rows)
    .onConflict((conflict) =>
      conflict.columns(["priceBookId", "dimension"]).doUpdateSet((eb) => ({
        unitMicroUsd: eb.ref("excluded.unitMicroUsd"),
        includedFreeQuantity: eb.ref("excluded.includedFreeQuantity"),
        overheadBps: eb.ref("excluded.overheadBps"),
        rounding: eb.ref("excluded.rounding"),
      })),
    )
    .execute()
}

export async function down(db: Kysely<MigrationDB>): Promise<void> {
  await db.deleteFrom("priceBook").where("version", "=", VERSION).execute()
  const previous = ACTIVE_DIMENSIONS.filter((dimension) => !ADDED_RATES.has(dimension))
  await dimensions(db, "price_book_item", previous)
  for (const table of ["usage_rollup", "statement_line_item"]) {
    await dimensions(db, table, [...previous, ...RETIRED_DIMENSIONS])
  }
  await db.schema.alterTable("price_book_item").dropColumn("overhead_bps").execute()
}
