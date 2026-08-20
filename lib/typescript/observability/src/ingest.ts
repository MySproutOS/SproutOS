import { clickhouse } from "./client"
import { parseLogsRequest, type LogRow } from "./otlp"
import type { Stream } from "./streams"

/**
 * The result of one ingest call, shaped for an OTLP partial-success response.
 *
 * OTLP is explicit that a server which drops some records must say how many, rather than returning
 * 200 and losing them quietly. An exporter that is told nothing has no way to know its telemetry is
 * not arriving — which is a bad failure for a product whose whole job is telling you what happened.
 */
export type IngestResult = {
  accepted: number
  rejected: number
  bytes: number
  message?: string
}

/**
 * The most records one request may carry.
 *
 * An OTel exporter's default batch is 512 and its maximum queue is a few thousand. This is well
 * above any of that, and it bounds what one unauthenticated-until-checked request can make this
 * process allocate.
 */
export const MAX_RECORDS_PER_REQUEST = 50_000

export async function ingestLogs(
  stream: Stream,
  payload: unknown,
  bytes: number,
): Promise<IngestResult> {
  const parsed = parseLogsRequest(payload)
  if (parsed.length === 0) return { accepted: 0, rejected: 0, bytes }

  const accepted = parsed.slice(0, MAX_RECORDS_PER_REQUEST)
  const rejected = parsed.length - accepted.length

  await clickhouse().insert({
    table: "log_record",
    values: accepted.map((row) => toRow(row, stream)),
    format: "JSONEachRow",
  })

  return {
    accepted: accepted.length,
    rejected,
    bytes,
    ...(rejected > 0
      ? { message: `Only the first ${MAX_RECORDS_PER_REQUEST} records in a request are accepted` }
      : {}),
  }
}

/**
 * Stamps a parsed record with who it belongs to.
 *
 * `project_id`, `organization_id` and `retention_days` come from the **resolved stream**, never
 * from the payload. A tenant that could name its own project id in an OTLP attribute could write
 * into another tenant's logs, and one that could name its own retention could keep data forever on
 * the cheapest plan.
 */
function toRow(row: LogRow, stream: Stream) {
  return {
    project_id: stream.projectId,
    organization_id: stream.organizationId,
    timestamp: row.timestamp,
    observed_timestamp: row.observedTimestamp,
    severity_number: row.severityNumber,
    severity_text: row.severityText,
    body: row.body,
    trace_id: row.traceId,
    span_id: row.spanId,
    service_name: row.serviceName,
    scope_name: row.scopeName,
    attributes: row.attributes,
    resource_attributes: row.resourceAttributes,
    retention_days: stream.retentionDays,
  }
}
