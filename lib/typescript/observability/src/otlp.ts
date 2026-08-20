/**
 * Parsing OTLP/HTTP JSON into rows.
 *
 * This accepts what an OpenTelemetry exporter sends, which is the protobuf JSON mapping: fields are
 * `camelCase`, 64-bit numbers are **strings**, and `oneof` values are wrapped in a type tag
 * (`{"stringValue": "x"}`). Two details that are easy to get wrong and silently lose data:
 *
 * - **`timeUnixNano` is a string.** Parsing it as a JavaScript number loses precision above 2^53,
 *   which every real nanosecond timestamp is. It is handled as `bigint` throughout.
 * - **snake_case is legal too.** The protobuf JSON mapping says a parser must accept both
 *   spellings, and some SDKs emit `time_unix_nano`. Accepting only one drops records from whichever
 *   half of the ecosystem we did not test against.
 */

export type LogRow = {
  timestamp: string
  observedTimestamp: string
  severityNumber: number
  severityText: string
  body: string
  traceId: string
  spanId: string
  serviceName: string
  scopeName: string
  attributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export class MalformedOtlpError extends Error {
  override readonly name = "MalformedOtlpError"
}

type Json = Record<string, unknown>

/** Reads a field under either the camelCase or the snake_case spelling. */
function field(source: Json, camel: string, snake: string): unknown {
  return source[camel] ?? source[snake]
}

function asArray(value: unknown): Json[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new MalformedOtlpError("expected an array")
  return value.filter((entry): entry is Json => typeof entry === "object" && entry !== null)
}

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {}
}

/**
 * Flattens an OTLP `AnyValue` to a string.
 *
 * Log attributes can be arrays and nested maps. ClickHouse's `Map(String, String)` cannot hold
 * those, so a structured value is stored as JSON rather than dropped: a customer who put an object
 * in an attribute can still find it, and nothing about the record goes missing without saying so.
 */
export function anyValueToString(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  // A bare symbol or function is not something JSON can carry, so it cannot have come from a
  // parsed OTLP body. Refusing to stringify it keeps `[object Object]` out of a customer's logs.
  if (typeof value !== "object") return ""

  const wrapped = value as Json
  const string = field(wrapped, "stringValue", "string_value")
  if (typeof string === "string") return string

  const bool = field(wrapped, "boolValue", "bool_value")
  if (typeof bool === "boolean") return String(bool)

  const int = field(wrapped, "intValue", "int_value")
  if (typeof int === "string" || typeof int === "number") return String(int)

  const double = field(wrapped, "doubleValue", "double_value")
  if (typeof double === "number") return String(double)

  const bytes = field(wrapped, "bytesValue", "bytes_value")
  if (typeof bytes === "string") return bytes

  return JSON.stringify(
    field(wrapped, "arrayValue", "array_value") ??
      field(wrapped, "kvlistValue", "kvlist_value") ??
      wrapped,
  )
}

/** Turns an OTLP `KeyValue` list into a flat map. */
export function attributesToMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of asArray(value)) {
    const key = entry.key
    if (typeof key !== "string" || key === "") continue
    out[key] = anyValueToString(entry.value)
  }
  return out
}

/**
 * Converts a nanosecond timestamp to what ClickHouse's `DateTime64(9)` wants.
 *
 * As a string, always. The value routinely exceeds `Number.MAX_SAFE_INTEGER` — 2^53 nanoseconds ran
 * out in 1970 plus a hundred days — so anything that touches it as a `number` silently rounds a
 * customer's timestamps to the nearest few hundred nanoseconds.
 */
export function nanosToClickhouse(nanos: unknown): string | undefined {
  if (nanos === undefined || nanos === null || nanos === "") return undefined
  let value: bigint
  try {
    value = BigInt(nanos as string | number)
  } catch {
    return undefined
  }
  if (value <= 0n) return undefined

  const seconds = value / 1_000_000_000n
  const remainder = value % 1_000_000_000n
  return `${seconds}.${remainder.toString().padStart(9, "0")}`
}

/** Now, in the same format, for a record that arrived without a usable timestamp. */
function nowAsClickhouse(): string {
  return nanosToClickhouse(BigInt(Date.now()) * 1_000_000n) ?? "0.000000000"
}

const SEVERITY_TEXT: Record<number, string> = {
  1: "TRACE",
  5: "DEBUG",
  9: "INFO",
  13: "WARN",
  17: "ERROR",
  21: "FATAL",
}

/** OTel severity numbers come in bands of four; the band's base is its name. */
function severityTextFor(number: number): string {
  if (number <= 0) return ""
  const base = Math.floor((number - 1) / 4) * 4 + 1
  return SEVERITY_TEXT[base] ?? ""
}

/**
 * Parses one OTLP `ExportLogsServiceRequest` into rows.
 *
 * Resource attributes are merged down into every record rather than stored once and joined. Logs
 * are read by time range and thrown away by TTL; a join to a resource table would make every query
 * pay for normalization that nothing ever updates.
 */
export function parseLogsRequest(payload: unknown): LogRow[] {
  if (typeof payload !== "object" || payload === null) {
    throw new MalformedOtlpError("the body is not an object")
  }
  const root = payload as Json

  const rows: LogRow[] = []
  for (const resourceLogs of asArray(field(root, "resourceLogs", "resource_logs"))) {
    const resource = asObject(resourceLogs.resource)
    const resourceAttributes = attributesToMap(resource.attributes)
    const serviceName = resourceAttributes["service.name"] ?? ""

    for (const scopeLogs of asArray(field(resourceLogs, "scopeLogs", "scope_logs"))) {
      const scope = asObject(scopeLogs.scope)
      const scopeName = typeof scope.name === "string" ? scope.name : ""

      for (const record of asArray(field(scopeLogs, "logRecords", "log_records"))) {
        const observed =
          nanosToClickhouse(field(record, "observedTimeUnixNano", "observed_time_unix_nano")) ??
          nowAsClickhouse()
        /*
          `timeUnixNano` is optional in the spec and exporters do omit it — it is the time the event
          happened, which the SDK may not know. `observedTimeUnixNano` is when the SDK saw it, and
          falling back to that beats storing 1970 and having every query miss the record.
        */
        const timestamp =
          nanosToClickhouse(field(record, "timeUnixNano", "time_unix_nano")) ?? observed

        const severityNumber = Number(field(record, "severityNumber", "severity_number") ?? 0)
        const severityText = field(record, "severityText", "severity_text")

        rows.push({
          timestamp,
          observedTimestamp: observed,
          severityNumber: Number.isFinite(severityNumber) ? severityNumber : 0,
          severityText:
            typeof severityText === "string" && severityText !== ""
              ? severityText
              : severityTextFor(severityNumber),
          body: anyValueToString(record.body),
          traceId:
            typeof field(record, "traceId", "trace_id") === "string"
              ? (field(record, "traceId", "trace_id") as string)
              : "",
          spanId:
            typeof field(record, "spanId", "span_id") === "string"
              ? (field(record, "spanId", "span_id") as string)
              : "",
          serviceName,
          scopeName,
          attributes: attributesToMap(record.attributes),
          resourceAttributes,
        })
      }
    }
  }

  return rows
}
