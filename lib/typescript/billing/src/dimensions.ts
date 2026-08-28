export type DimensionDisplay = { label: string; unit: string; divisor: bigint }

/** Customer-facing names and units for the metering vocabulary. */
export const DIMENSION_DISPLAY: Record<string, DimensionDisplay> = {
  site_gib_second: { label: "Compute", unit: "GB-hours", divisor: 3_600n },
  site_provisioned_gib_second: {
    label: "Provisioned memory",
    unit: "GiB-hours",
    divisor: 3_600n,
  },
  site_request: { label: "Requests", unit: "requests", divisor: 1n },
  site_egress_byte: { label: "Egress", unit: "GB", divisor: 1_000_000_000n },
  db_storage_gib_hour: { label: "Postgres storage (legacy)", unit: "GiB-months", divisor: 730n },
  db_storage_gb_month: { label: "Postgres storage", unit: "GB-months", divisor: 1n },
  db_history_storage_gb_month: { label: "History storage", unit: "GB-months", divisor: 1n },
  db_compute_cu_second: { label: "Postgres compute", unit: "CU-hours", divisor: 3_600n },
  es_storage_gib_hour: { label: "Search storage", unit: "GiB-months", divisor: 730n },
  es_search_unit: { label: "Search queries", unit: "queries", divisor: 1n },
  valkey_queue_byte_second: {
    label: "Queue storage",
    unit: "GiB-hours",
    divisor: 3_865_470_566_400n,
  },
  workflow_job_enqueued: { label: "Workflow jobs", unit: "jobs", divisor: 1n },
  workflow_exec_vcpu_second: {
    label: "Workflow compute",
    unit: "vCPU-hours",
    divisor: 3_600n,
  },
  workflow_exec_gib_second: {
    label: "Workflow memory",
    unit: "GiB-hours",
    divisor: 3_600n,
  },
  ai_input_token: { label: "AI input", unit: "tokens", divisor: 1n },
  ai_output_token: { label: "AI output", unit: "tokens", divisor: 1n },
  ai_cache_read_token: { label: "AI cache reads", unit: "tokens", divisor: 1n },
  ai_cache_write_token: { label: "AI cache writes", unit: "tokens", divisor: 1n },
  ai_long_context_input_token: { label: "AI long-context input", unit: "tokens", divisor: 1n },
  ai_long_context_output_token: { label: "AI long-context output", unit: "tokens", divisor: 1n },
  ai_long_context_cache_read_token: {
    label: "AI long-context cache reads",
    unit: "tokens",
    divisor: 1n,
  },
  ai_long_context_cache_write_token: {
    label: "AI long-context cache writes",
    unit: "tokens",
    divisor: 1n,
  },
  agent_run_second: { label: "Agent time", unit: "hours", divisor: 3_600n },
  sandbox_cpu_second: { label: "Sandbox CPU", unit: "vCPU-hours", divisor: 3_600n },
  sandbox_gib_second: { label: "Sandbox memory", unit: "GiB-hours", divisor: 3_600n },
  sandbox_disk_gib_second: { label: "Sandbox disk", unit: "GiB-hours", divisor: 3_600n },
  sandbox_egress_byte: { label: "Sandbox egress", unit: "GB", divisor: 1_000_000_000n },
}

const SCALE = 1_000_000_000n

function scaledDecimal(value: string): bigint {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [whole = "0", fraction = ""] = unsigned.split(".")
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new RangeError(`Not a decimal quantity: ${value}`)
  }
  const result = BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(9)).slice(0, 9))
  return negative ? -result : result
}

function decimalString(value: bigint, maximumFractionDigits = 2): string {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const whole = absolute / SCALE
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(9, "0")
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole.toString()}${fraction === "" ? "" : `.${fraction}`}`
}

/** Divide an exact numeric quantity without converting it through a JavaScript number. */
export function displayQuantity(raw: string, divisor: bigint, maximumFractionDigits = 2): string {
  return decimalString(scaledDecimal(raw) / divisor, maximumFractionDigits)
}

export function displayForDimension(dimension: string): DimensionDisplay {
  return DIMENSION_DISPLAY[dimension] ?? { label: dimension, unit: "units", divisor: 1n }
}
