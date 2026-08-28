import type { Kysely } from "kysely"
import { asRow, text } from "../lib/rows"
import { uuidV7 } from "../lib/uuid"

const PRICE_BOOK_VERSION = 2
const DEFAULT_OVERHEAD_BPS = 1200
const EFFECTIVE_AT = new Date("2026-01-01T00:00:00.000Z")

/**
 * `unit_micro_usd` is a rate in micro-USD per unit, `numeric(38, 9)` rather than `bigint`,
 * because $0.30 per million cache-read tokens is 0.3 micro-USD per token. Rating rounds the
 * product to whole micro-USD; every money *amount* in the schema stays `bigint`.
 */
const ITEMS: [dimension: string, unitMicroUsd: string][] = [
  /*
    Compute is GB-seconds and nothing else.

    Lambda allocates CPU in proportion to configured memory — there is no vCPU knob and no vCPU
    charge — and it bills wall-clock billed duration, not the time a request spent using CPU. Two
    dimensions here described the other model (Vercel Fluid's, which discounts IO wait) and were
    retired by `2026_09_20_00_00_00_lambda_billing`; a rate for them would have meant charging a
    customer less than their invocation cost us on every database-bound request.
  */
  ["site_gib_second", "3"],
  ["site_provisioned_gib_second", "3"],
  ["site_request", "2"],
  // Static delivery uses CloudFront standard-log sc-bytes: the full server-to-viewer response,
  // including headers and every HTTP method. This is the explicit customer price-book quantity,
  // not a claim that CloudWatch BytesDownloaded (GET/HEAD only) is provider-equivalent.
  ["site_egress_byte", "0.00014"],
  // Neon Launch pass-through: $0.106/CU-hour and $0.35 per decimal GB-month.
  ["db_storage_gib_hour", "514.807723836"], // Legacy byte-month conversion compatibility.
  ["db_storage_gb_month", "350000"],
  ["db_history_storage_gb_month", "200000"],
  ["db_compute_cu_second", "29.444444444"],
  ["es_storage_gib_hour", "300"],
  ["es_search_unit", "1"],
  ["valkey_queue_byte_second", "0.000001"],
  ["workflow_job_enqueued", "5"],
  ["workflow_exec_vcpu_second", "36"],
  ["workflow_exec_gib_second", "3"],
  // OpenAI gpt-5.6-terra pass-through: $2/M input, $12/M output, $0.20/M cached input.
  // Request-scoped long-context and cache-write buckets preserve the provider's actual rates.
  ["ai_input_token", "2"],
  ["ai_output_token", "12"],
  ["ai_cache_read_token", "0.2"],
  ["ai_cache_write_token", "2.5"],
  ["ai_long_context_input_token", "4"],
  ["ai_long_context_output_token", "18"],
  ["ai_long_context_cache_read_token", "0.4"],
  ["ai_long_context_cache_write_token", "5"],
  // Operational duration only. Sandbox and token usage already carry the provider cost.
  ["agent_run_second", "0"],
  /*
    Sandboxes, priced against what the provider charges us rather than against Lambda.

    Daytona bills per second at $0.0504 per vCPU-hour, $0.0162 per GiB-hour of memory and
    $0.000108 per GiB-hour of disk — 14, 4.5 and 0.03 micro-USD per second respectively, which
    `PROVIDER_COST_MICRO_USD_PER_SECOND` in `@lib/jobs/sandbox` repeats so the two can be compared.
    These are exact pass-through rates. Sandbox items are also exempt from the book's platform
    overhead, so the quantity and the provider rate are the whole customer charge.

    A vCPU rate exists here and deliberately not for `site_*`. `2026_09_20_00_00_00_lambda_billing`
    retired two CPU-time dimensions because Lambda allocates CPU in proportion to memory and has no
    vCPU knob to charge for. A sandbox has real, requested CPU limits, so the knob is back and so is
    the charge.
  */
  ["sandbox_cpu_second", "14"],
  ["sandbox_gib_second", "4.5"],
  ["sandbox_disk_gib_second", "0.03"],
  // AWS US-East first-tier internet DTO, $0.09 per decimal GB. One proxy exchange can create two
  // outbound legs; the Rust meter counts the bytes actually written on both.
  ["sandbox_egress_byte", "0.00009"],
]

const ITEM_OVERHEAD_BPS = new Map<string, number>([
  ["db_compute_cu_second", 200],
  ["db_storage_gib_hour", 0],
  ["db_storage_gb_month", 0],
  ["db_history_storage_gb_month", 0],
  ["ai_input_token", 0],
  ["ai_output_token", 0],
  ["ai_cache_read_token", 0],
  ["ai_cache_write_token", 0],
  ["ai_long_context_input_token", 0],
  ["ai_long_context_output_token", 0],
  ["ai_long_context_cache_read_token", 0],
  ["ai_long_context_cache_write_token", 0],
  ["agent_run_second", 0],
  ["sandbox_cpu_second", 0],
  ["sandbox_gib_second", 0],
  ["sandbox_disk_gib_second", 0],
  ["sandbox_egress_byte", 0],
])

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
        name: "Launch provider pass-through",
        currency: "USD",
        overhead_bps: DEFAULT_OVERHEAD_BPS,
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
        overhead_bps: ITEM_OVERHEAD_BPS.get(dimension) ?? null,
        rounding: "half_even",
      })),
    )
    // Seeds are also the repair path. `doNothing` left an already-deployed price book permanently
    // stale when a rate changed, even though re-running the seed reported success.
    .onConflict((oc) =>
      oc.columns(["price_book_id", "dimension"]).doUpdateSet((eb) => ({
        included_free_quantity: eb.ref("excluded.included_free_quantity"),
        overhead_bps: eb.ref("excluded.overhead_bps"),
        rounding: eb.ref("excluded.rounding"),
        unit_micro_usd: eb.ref("excluded.unit_micro_usd"),
      })),
    )
    .execute()
}
