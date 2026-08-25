import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Three dimensions for sandbox compute.
 *
 * A sandbox is billed on what we asked the provider for and how long it ran: vCPU-seconds,
 * GiB-seconds of memory, GiB-seconds of disk. All three, not one composite, because the provider
 * prices them separately and a customer looking at a bill should be able to see which of the three
 * they are paying for — a single `sandbox_second` would hide a machine that is large in one
 * dimension behind an average.
 *
 * ## Why a vCPU dimension is back
 *
 * `2026_09_20_00_00_00_lambda_billing` retired `site_vcpu_second` and `site_active_cpu_second`
 * because Lambda allocates CPU in proportion to configured memory: there is no vCPU knob, so a rate
 * for one would have meant charging less than the invocation cost us on every IO-bound request.
 *
 * A sandbox is not Lambda. `cpu` is a number we send to the provider and are billed for directly,
 * so the knob exists and so does the charge. That migration's reasoning is not being reversed — it
 * was about a platform that had no such knob, and this one does.
 *
 * ## The order here is not arbitrary
 *
 * The constraint is widened before anything writes a row that needs it, which is the opposite of
 * the sequencing the lambda migration had to fix ("check constraint is violated by some row"). Both
 * tables get it: `usage_event` because the meter writes there every minute, and `price_book_item`
 * because the seed writes the rate. A row on either side without the other is a dimension that
 * meters and never rates, which produces usage a customer can see and is never charged for.
 */
const ADDED = ["sandbox_cpu_second", "sandbox_gib_second", "sandbox_disk_gib_second"]

const EXISTING = [
  "site_gib_second",
  "site_provisioned_gib_second",
  "site_request",
  "site_egress_byte",
  "site_ws_connection_second",
  "db_storage_gib_hour",
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
  "agent_run_second",
]

function list(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ")
}

async function setChecks(db: Kysely<unknown>, dimensions: string[]): Promise<void> {
  const values = list(dimensions)

  await sql`alter table usage_event drop constraint if exists usage_event_dimension_check`.execute(
    db,
  )
  await sql`
    alter table usage_event add constraint usage_event_dimension_check
      check (dimension in (${sql.raw(values)}))
  `.execute(db)

  await sql`alter table price_book_item drop constraint if exists price_book_item_dimension_check`.execute(
    db,
  )
  await sql`
    alter table price_book_item add constraint price_book_item_dimension_check
      check (dimension in (${sql.raw(values)}))
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setChecks(db, [...EXISTING, ...ADDED])
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /*
    Refuse rather than delete, the same way the lambda migration did.

    A `usage_event` row is a charge that has been or will be reconciled into a statement. Dropping
    rows to satisfy a narrowed constraint makes a customer's invoice stop adding up, and it does so
    silently. The rate rows are safe to remove — a price is not a charge.
  */
  const stranded = await sql<{ count: string }>`
    select count(*)::text as count from usage_event where dimension in (${sql.raw(list(ADDED))})
  `.execute(db)

  const count = Number(stranded.rows[0]?.count ?? "0")
  if (count > 0) {
    throw new Error(
      `${count} usage_event row(s) are on a sandbox dimension (${ADDED.join(", ")}). These are ` +
        `real metered usage; deleting them would break statement reconciliation. Archive them ` +
        `before rolling this migration back.`,
    )
  }

  await sql`delete from price_book_item where dimension in (${sql.raw(list(ADDED))})`.execute(db)
  await setChecks(db, EXISTING)
}
