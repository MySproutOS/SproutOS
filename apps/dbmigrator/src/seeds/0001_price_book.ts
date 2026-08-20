import type { Kysely } from "kysely"
import { asRow, text } from "../lib/rows"
import { uuidV7 } from "../lib/uuid"

const PRICE_BOOK_VERSION = 1
const OVERHEAD_BPS = 1200
const EFFECTIVE_AT = new Date("2026-01-01T00:00:00.000Z")

/**
 * `unit_micro_usd` is a rate in micro-USD per unit, `numeric(38, 9)` rather than `bigint`,
 * because $0.30 per million cache-read tokens is 0.3 micro-USD per token. Rating rounds the
 * product to whole micro-USD; every money *amount* in the schema stays `bigint`.
 */
const ITEMS: [dimension: string, unitMicroUsd: string][] = [
  ["site_vcpu_second", "36"],
  ["site_active_cpu_second", "36"],
  ["site_gib_second", "3"],
  ["site_provisioned_gib_second", "3"],
  ["site_ws_connection_second", "0.5"],
  ["site_request", "2"],
  ["site_egress_byte", "0.00014"],
  ["db_storage_gib_hour", "480"],
  ["db_compute_cu_second", "45"],
  ["es_storage_gib_hour", "300"],
  ["es_search_unit", "1"],
  ["valkey_queue_byte_second", "0.000001"],
  ["workflow_job_enqueued", "5"],
  ["workflow_exec_vcpu_second", "36"],
  ["workflow_exec_gib_second", "3"],
  ["ai_input_token", "3.3"],
  ["ai_output_token", "16.5"],
  ["ai_cache_read_token", "0.33"],
  ["agent_run_second", "40"],
]

export async function seed(db: Kysely<any>): Promise<void> {
  const existing = asRow(
    await db
      .selectFrom("price_book")
      .select(["id"])
      .where("version", "=", PRICE_BOOK_VERSION)
      .executeTakeFirst(),
  )

  const priceBookId = existing ? text(existing, "id") : uuidV7()

  if (!existing) {
    await db
      .insertInto("price_book")
      .values({
        id: priceBookId,
        version: PRICE_BOOK_VERSION,
        name: "Launch",
        currency: "USD",
        overhead_bps: OVERHEAD_BPS,
        effective_at: EFFECTIVE_AT,
      })
      .execute()
  }

  await db
    .insertInto("price_book_item")
    .values(
      ITEMS.map(([dimension, unitMicroUsd]) => ({
        id: uuidV7(),
        price_book_id: priceBookId,
        dimension,
        unit_micro_usd: unitMicroUsd,
        included_free_quantity: "0",
        rounding: "half_even",
      })),
    )
    .onConflict((oc) => oc.columns(["price_book_id", "dimension"]).doNothing())
    .execute()
}
