import { sql, type Kysely } from "kysely"

/**
 * The list of billable dimensions lives in four tables. Two of them were a release behind.
 *
 * `usage_event` and `price_book_item` were widened for sandbox billing and narrowed when Lambda
 * retired the vCPU dimensions. `usage_rollup` and `statement_line_item` were not touched by either,
 * so they still permitted `site_vcpu_second` and `site_active_cpu_second` and still refused every
 * sandbox dimension.
 *
 * ## What that actually did
 *
 * Not "sandboxes are not billed". `rollUpUsage` is one job over every organization's unrated
 * events, in one statement per grain — so the first metered sandbox anywhere made it fail on
 * `usage_rollup_dimension_check`, and **no usage on the platform was rolled up or charged for as
 * long as one existed**. A feature nobody had used yet would have stopped the billing of everybody
 * who had. It was found by metering a sandbox for the first time and watching six billing tests
 * fail on a constraint.
 *
 * ## Widened, not aligned
 *
 * The first version of this migration made all four lists identical, which meant dropping
 * `site_vcpu_second` and `site_active_cpu_second` from these two. It refused to run: five
 * `usage_rollup` rows in a development database are on those dimensions, and they are real —
 * rolled up before Lambda retired them. Narrowing would have meant deleting rows a statement is
 * reconciled from, to fix a bug about billing.
 *
 * So the rule downstream is *superset*, not equality: a rollup or a line item may carry a
 * dimension no new event can be written on, because history happened. What must never be true is
 * the reverse — a dimension the meter can write that the rollup refuses, which is what stopped the
 * platform's billing.
 *
 * ## Why it recurred
 *
 * The sandbox migration's own comment says "Both tables get it" and names two. It was right about
 * the mechanism and wrong about the count, and nothing checked. `dimension-checks.test.ts` now
 * reads all four out of `pg_constraint` and asserts they are the same set, so the next dimension
 * added to three of four fails a test rather than a customer's invoice.
 */
const DIMENSIONS = [
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
  "sandbox_cpu_second",
  "sandbox_gib_second",
  "sandbox_disk_gib_second",
]

/** The two that were left behind. */
const BEHIND = ["usage_rollup", "statement_line_item"]

/**
 * Retired for new events by the Lambda migration, and kept here.
 *
 * Rows on these exist and are reconciled into statements. They are history, not a dimension
 * anything will write again.
 */
const RETIRED = ["site_vcpu_second", "site_active_cpu_second"]

function list(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ")
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of BEHIND) {
    await sql`
      alter table ${sql.table(table)} drop constraint if exists ${sql.raw(`${table}_dimension_check`)}
    `.execute(db)
    await sql`
      alter table ${sql.table(table)} add constraint ${sql.raw(`${table}_dimension_check`)}
        check (dimension in (${sql.raw(list([...DIMENSIONS, ...RETIRED]))}))
    `.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /*
    Back to refusing the sandbox dimensions — and refusing rather than deleting the rows that hold
    them, which is the same rule this migration exists to keep. A rollup row is what an invoice is
    reconciled from; dropping one to satisfy a narrowed constraint makes the invoice stop adding up
    and says nothing.
  */
  const sandbox = DIMENSIONS.filter((it) => it.startsWith("sandbox_"))

  for (const table of BEHIND) {
    const stranded = await sql<{ count: string }>`
      select count(*)::text as count from ${sql.table(table)}
       where dimension in (${sql.raw(list(sandbox))})
    `.execute(db)

    const count = Number(stranded.rows[0]?.count ?? "0")
    if (count > 0) {
      throw new Error(
        `${count} ${table} row(s) are on a sandbox dimension. These are reconciled into ` +
          `statements; archive them before narrowing this constraint.`,
      )
    }
  }

  for (const table of BEHIND) {
    await sql`
      alter table ${sql.table(table)} drop constraint if exists ${sql.raw(`${table}_dimension_check`)}
    `.execute(db)
    await sql`
      alter table ${sql.table(table)} add constraint ${sql.raw(`${table}_dimension_check`)}
        check (dimension in (${sql.raw(list([...DIMENSIONS.filter((it) => !it.startsWith("sandbox_")), ...RETIRED]))}))
    `.execute(db)
  }
}
