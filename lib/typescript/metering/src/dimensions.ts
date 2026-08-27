/**
 * Dimensions accepted from new usage events.
 *
 * This tuple is deliberately useful at runtime as well as in the type system: ingest can reject an
 * unknown value before a durable emitter retries it forever. Its exact contents are asserted
 * against `lib/rust/metering-proto/fixtures/billable-dimensions.json` by both languages. Historical
 * rollups may contain retired dimensions; those are not valid new events and do not belong here.
 */
export const BILLABLE_DIMENSIONS = [
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
  "sandbox_egress_byte",
] as const

export type BillableDimension = (typeof BILLABLE_DIMENSIONS)[number]

const billableDimensions: ReadonlySet<string> = new Set(BILLABLE_DIMENSIONS)

/** Narrows an untrusted wire value to a dimension the current price book can bill. */
export function isBillableDimension(value: unknown): value is BillableDimension {
  return typeof value === "string" && billableDimensions.has(value)
}
