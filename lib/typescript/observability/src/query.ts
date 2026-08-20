import { clickhouse } from "./client"

/**
 * Reading logs back.
 *
 * Every query here is parameterized and every one is scoped to a single `project_id` that the
 * caller does **not** supply — the route resolves it from the URL and checks RBAC first. There is
 * no code path in this file that reads across projects, which is the property that makes the log
 * store multi-tenant rather than merely shared.
 */

export type LogQuery = {
  projectId: string
  /** Inclusive lower bound, ISO 8601. */
  since: string
  /** Exclusive upper bound, ISO 8601. */
  until: string
  /** Substring of the body. Matched with `hasToken` where possible; see below. */
  search?: string
  /** Minimum OTel severity number: 9 is INFO, 17 is ERROR. */
  minSeverity?: number
  service?: string
  traceId?: string
  limit: number
  /**
   * Keyset cursor: return records strictly older than this, as a nanosecond timestamp.
   *
   * Nanoseconds rather than a formatted datetime, because the cursor has to round-trip *exactly*.
   * `toString` on a `DateTime64(9)` produces `2026-08-20 12:37:31.778000000` with no timezone, and
   * a cursor that has to be reparsed in an assumed zone is a cursor that skips or repeats rows the
   * day the server's zone is not what the client assumed.
   */
  before?: string
}

export type LogLine = {
  /** ISO 8601, UTC, with all nine fractional digits kept. */
  timestamp: string
  /** The same instant as a nanosecond count — pass it back as `before` to page. */
  cursor: string
  severityNumber: number
  severityText: string
  body: string
  serviceName: string
  scopeName: string
  traceId: string
  spanId: string
  attributes: Record<string, string>
}

/**
 * Formats a nanosecond timestamp as ISO 8601 in UTC, keeping all nine digits.
 *
 * `new Date()` only has milliseconds, so the sub-millisecond part is carried separately and
 * appended. Truncating to milliseconds would be fine for reading a log line and wrong for anything
 * that orders events inside a single request.
 */
export function nanosToIso(nanos: string): string {
  const value = BigInt(nanos)
  const milliseconds = value / 1_000_000n
  const remainder = value % 1_000_000n
  const base = new Date(Number(milliseconds)).toISOString()
  return `${base.slice(0, -1)}${remainder.toString().padStart(6, "0")}Z`
}

/** The most lines one page may hold, whatever the caller asks for. */
export const MAX_LIMIT = 500

export async function searchLogs(
  query: LogQuery,
): Promise<{ lines: LogLine[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(query.limit, 1), MAX_LIMIT)

  const conditions = [
    "project_id = {projectId: UUID}",
    "timestamp >= parseDateTime64BestEffort({since: String}, 9)",
    "timestamp < parseDateTime64BestEffort({until: String}, 9)",
  ]
  const parameters: Record<string, unknown> = {
    projectId: query.projectId,
    since: query.since,
    until: query.until,
    // One more than asked for, so "is there another page" is answered without a second count query
    // over the same range.
    limit: limit + 1,
  }

  if (query.search !== undefined && query.search !== "") {
    /*
      `positionCaseInsensitive` rather than `hasToken`.

      The bloom-filter skip index only accelerates whole tokens, but a log search for `timeout` on a
      body reading `connect_timeout=30` has to match — a search box that silently required exact
      token boundaries would look broken. ClickHouse still uses the index where the term happens to
      be a token, so this is slower in the worst case and correct in every case.
    */
    conditions.push("positionCaseInsensitive(body, {search: String}) > 0")
    parameters.search = query.search
  }
  if (query.minSeverity !== undefined) {
    conditions.push("severity_number >= {minSeverity: UInt8}")
    parameters.minSeverity = query.minSeverity
  }
  if (query.service !== undefined && query.service !== "") {
    conditions.push("service_name = {service: String}")
    parameters.service = query.service
  }
  if (query.traceId !== undefined && query.traceId !== "") {
    conditions.push("trace_id = {traceId: String}")
    parameters.traceId = query.traceId
  }
  if (query.before !== undefined && query.before !== "") {
    conditions.push("timestamp < fromUnixTimestamp64Nano(toInt64({before: String}))")
    parameters.before = query.before
  }

  /*
    Two details in the select list.

    `as ts`, not `as timestamp`: ClickHouse resolves aliases inside WHERE, so aliasing the projected
    value back onto the column's own name makes every predicate on the timestamp compare against the
    projection instead of the column, and the query is refused outright.

    And the nanosecond count rather than `toString(timestamp)`, which yields a datetime with no
    timezone — exact, unambiguous, and the same value that goes back out as the cursor.
  */
  const result = await clickhouse().query({
    query: `
      select
        toString(toUnixTimestamp64Nano(timestamp)) as ts,
        severity_number,
        severity_text,
        body,
        service_name,
        scope_name,
        trace_id,
        span_id,
        attributes
      from log_record
      where ${conditions.join(" and ")}
      order by timestamp desc
      limit {limit: UInt32}
    `,
    query_params: parameters,
    format: "JSONEachRow",
  })

  type Row = {
    ts: string
    severity_number: number
    severity_text: string
    body: string
    service_name: string
    scope_name: string
    trace_id: string
    span_id: string
    attributes: Record<string, string>
  }

  const rows = await result.json<Row>()
  const page = rows.slice(0, limit)

  return {
    lines: page.map((row) => ({
      timestamp: nanosToIso(row.ts),
      cursor: row.ts,
      severityNumber: row.severity_number,
      severityText: row.severity_text,
      body: row.body,
      serviceName: row.service_name,
      scopeName: row.scope_name,
      traceId: row.trace_id,
      spanId: row.span_id,
      attributes: row.attributes,
    })),
    // Only when a row beyond the page actually exists. Returning a cursor unconditionally makes a
    // client fetch one empty page at the end of every result set.
    nextBefore: rows.length > limit ? (page[page.length - 1]?.ts ?? null) : null,
  }
}

/**
 * How much a project has ingested, for the usage line on a bill.
 *
 * Counted from the stored rows rather than from a counter incremented at ingest, because a counter
 * and the data drift the moment a batch fails halfway.
 */
export async function projectUsage(
  projectId: string,
  since: string,
): Promise<{ records: number; bytes: number }> {
  const result = await clickhouse().query({
    query: `
      select
        count() as records,
        sum(length(body) + length(toString(attributes))) as bytes
      from log_record
      where project_id = {projectId: UUID}
        and timestamp >= parseDateTime64BestEffort({since: String}, 9)
    `,
    query_params: { projectId, since },
    format: "JSONEachRow",
  })

  const [row] = await result.json<{ records: string; bytes: string | null }>()
  return { records: Number(row?.records ?? 0), bytes: Number(row?.bytes ?? 0) }
}

/** The services a project has sent logs from, for the filter dropdown. */
export async function projectServices(projectId: string, since: string): Promise<string[]> {
  const result = await clickhouse().query({
    query: `
      select distinct service_name
      from log_record
      where project_id = {projectId: UUID}
        and timestamp >= parseDateTime64BestEffort({since: String}, 9)
        and service_name != ''
      order by service_name
      limit 100
    `,
    query_params: { projectId, since },
    format: "JSONEachRow",
  })
  return (await result.json<{ service_name: string }>()).map((row) => row.service_name)
}
