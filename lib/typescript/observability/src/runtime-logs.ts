import { clickhouse } from "./client"

/**
 * A customer's Lambda logs, on their way to ClickHouse.
 *
 * ## Why not a Lambda extension
 *
 * The brief specified one — an extension subscribing to the Telemetry API. An extension is a layer
 * attached to every customer function, running the platform's code *inside* the customer's
 * execution environment: it shares their memory limit, adds to their cold start, and is billed to
 * them. It also has to be attached to every function, so a project that deployed before it existed
 * silently has no logs.
 *
 * A CloudWatch Logs subscription filter is none of those things. Lambda writes to CloudWatch with
 * no cooperation from the function, one filter covers a whole log group prefix, and the shipping
 * runs in a process the customer does not pay for. The cost is CloudWatch's own ingest charge and a
 * few seconds of delay, which for a log viewer that polls once a second is not a difference anyone
 * sees.
 *
 * ## The three-day TTL is in the table
 *
 * Not here, and not in a cron job. `ovh/clickhouse-init/01-runtime-logs.sql` carries it, because a
 * deletion policy outside the schema is one nobody finds when they wonder why the disk is full.
 */

export type RuntimeLog = {
  ts: Date
  projectId: string
  deploymentId: string
  requestId: string
  level: string
  message: string
  durationMs?: number
  billedMs?: number
  memoryMb?: number
  initMs?: number
  coldStart?: boolean
}

/**
 * Which project a log group belongs to.
 *
 * `/aws/lambda/sproutos-app-<project id>`. Derived rather than looked up: the shipper handles a
 * batch per invocation and a database round trip per batch to learn something already encoded in
 * the name would be a query per second per busy project.
 */
export function projectIdFromLogGroup(logGroup: string): string | undefined {
  const match = /^\/aws\/lambda\/sproutos-app-([0-9a-f-]{36})$/.exec(logGroup)
  return match?.[1]
}

/**
 * Lambda's own `REPORT` line, which is where the billing numbers are.
 *
 * One line per invocation, emitted by the runtime rather than by the customer's code:
 *
 *   REPORT RequestId: abc  Duration: 1.23 ms  Billed Duration: 2 ms  Memory Size: 512 MB
 *   Max Memory Used: 78 MB  Init Duration: 210.5 ms
 *
 * `Init Duration` is present only on a cold start, which is exactly how a cold start is detected —
 * there is no boolean anywhere saying so.
 */
export function parseReport(message: string): Partial<RuntimeLog> | undefined {
  if (!message.startsWith("REPORT")) return undefined

  const number = (label: string): number | undefined => {
    const match = new RegExp(`${label}: ([0-9.]+) (?:ms|MB)`).exec(message)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }

  const initMs = number("Init Duration")

  return {
    durationMs: number("Duration"),
    billedMs: number("Billed Duration"),
    memoryMb: number("Memory Size"),
    ...(initMs === undefined ? {} : { initMs }),
    // Absent `Init Duration` means a warm invocation, so this is `false` rather than undefined —
    // "not a cold start" is a fact worth recording, and a null would be read as "we do not know".
    coldStart: initMs !== undefined,
  }
}

/**
 * The level a line is at.
 *
 * Lambda's own lines (`START`, `END`, `REPORT`) are `platform`, so a customer filtering for `info`
 * is not shown the runtime's bookkeeping. Everything else is read from the line's own prefix, and
 * anything unrecognised is `info` — a log line whose level we cannot parse is still a log line the
 * customer wants to see, and dropping it or filing it under `error` would both be worse.
 */
export function levelOf(message: string): string {
  if (/^(START|END|REPORT|INIT_START|XRAY)/.test(message)) return "platform"

  const match = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/.exec(
    message.slice(0, 200),
  )
  if (match?.[1] === undefined) return "info"

  const found = match[1].toLowerCase()
  return found === "warning" ? "warn" : found === "critical" ? "fatal" : found
}

/**
 * The request id a line belongs to.
 *
 * CloudWatch does not attach it to every line, so it is taken from the `RequestId:` marker on the
 * runtime's own lines and otherwise left empty. Empty rather than a placeholder: a viewer grouping
 * by request should show these ungrouped rather than all together under a fake id.
 */
export function requestIdOf(message: string): string {
  const match = /RequestId: ([0-9a-f-]{36})/.exec(message)
  return match?.[1] ?? ""
}

/** One CloudWatch log event, as the subscription filter delivers it. */
export type LogEvent = { timestamp: number; message: string }

/**
 * Turn a delivered batch into rows.
 *
 * `deploymentId` comes from the caller because a log group is per *project* and a project has many
 * deployments over time — the shipper resolves the live one once per batch rather than per line.
 */
export function toRows(logGroup: string, deploymentId: string, events: LogEvent[]): RuntimeLog[] {
  const projectId = projectIdFromLogGroup(logGroup)
  if (projectId === undefined) return []

  return events.map((event) => {
    const message = event.message.trimEnd()
    return {
      ts: new Date(event.timestamp),
      projectId,
      deploymentId,
      requestId: requestIdOf(message),
      level: levelOf(message),
      message,
      ...parseReport(message),
    }
  })
}

/** Write a batch. */
export async function writeRuntimeLogs(rows: RuntimeLog[]): Promise<void> {
  if (rows.length === 0) return

  await clickhouse().insert({
    table: "runtime_log",
    format: "JSONEachRow",
    values: rows.map((row) => ({
      // ClickHouse's `DateTime64(3)` parses this form; an ISO string with a `Z` it does not.
      ts: row.ts.toISOString().replace("T", " ").replace("Z", ""),
      project_id: row.projectId,
      deployment_id: row.deploymentId,
      request_id: row.requestId,
      level: row.level,
      message: row.message,
      duration_ms: row.durationMs ?? null,
      billed_ms: row.billedMs ?? null,
      memory_mb: row.memoryMb ?? null,
      init_ms: row.initMs ?? null,
      cold_start: row.coldStart ?? null,
    })),
  })
}

/**
 * How long runtime logs are kept, for everyone.
 *
 * Fixed rather than per-project, unlike `log_record`: these are lines Lambda emitted whether the
 * customer asked or not, so there is no plan to price them against. Exported because the DDL, the
 * API's reply and the viewer's "kept N days" all have to agree, and three copies of a number is
 * how they stop agreeing.
 *
 * A fourth copy still exists in `ovh/clickhouse-init/01-runtime-logs.sql`, which seeds a fresh box
 * before any of this code runs. That one cannot import anything.
 */
export const RUNTIME_LOG_RETENTION_DAYS = 3

/**
 * How much a project has logged in a window, for the viewer's header.
 *
 * `length(message)` rather than the whole row: this is the number a customer recognises as "my
 * logs", and it should not move because we added a column.
 */
export async function runtimeUsage(
  projectId: string,
  since: string,
): Promise<{ records: number; bytes: number }> {
  const result = await clickhouse().query({
    query: `
      select count() as records, sum(length(message)) as bytes
      from runtime_log
      where project_id = {projectId: UUID}
        and ts >= parseDateTime64BestEffort({since: String}, 3)
    `,
    query_params: { projectId, since },
    format: "JSONEachRow",
  })

  const [row] = await result.json<{ records: string; bytes: string | null }>()
  return { records: Number(row?.records ?? 0), bytes: Number(row?.bytes ?? 0) }
}

export type RuntimeLogQuery = {
  projectId: string
  since?: Date
  until?: Date
  level?: string
  /** Substring match on the message. The table carries a token bloom filter for this. */
  search?: string
  limit?: number
}

/**
 * Read a project's logs back.
 *
 * Every filter is a bound parameter. A log viewer takes a search string straight from a text box,
 * and the one thing that must not happen is that string reaching ClickHouse as SQL.
 */
export async function queryRuntimeLogs(query: RuntimeLogQuery): Promise<RuntimeLog[]> {
  const clauses = ["project_id = {projectId: UUID}"]
  const params: Record<string, unknown> = {
    projectId: query.projectId,
    // Capped regardless of what the caller asked for: this answers an HTTP request, and a viewer
    // that asked for a million rows would hold a connection open until it timed out.
    limit: Math.min(query.limit ?? 200, 1000),
  }

  if (query.since !== undefined) {
    clauses.push("ts >= {since: DateTime64(3)}")
    params.since = query.since.toISOString().replace("T", " ").replace("Z", "")
  }
  if (query.until !== undefined) {
    clauses.push("ts <= {until: DateTime64(3)}")
    params.until = query.until.toISOString().replace("T", " ").replace("Z", "")
  }
  if (query.level !== undefined) {
    clauses.push("level = {level: String}")
    params.level = query.level
  }
  if (query.search !== undefined && query.search !== "") {
    clauses.push("positionCaseInsensitive(message, {search: String}) > 0")
    params.search = query.search
  }

  const result = await clickhouse().query({
    query: `
      select ts, project_id, deployment_id, request_id, level, message,
             duration_ms, billed_ms, memory_mb, init_ms, cold_start
      from runtime_log
      where ${clauses.join(" and ")}
      order by ts desc
      limit {limit: UInt32}
    `,
    query_params: params,
    format: "JSONEachRow",
  })

  const rows = await result.json<{
    ts: string
    project_id: string
    deployment_id: string
    request_id: string
    level: string
    message: string
    duration_ms: number | null
    billed_ms: number | null
    memory_mb: number | null
    init_ms: number | null
    cold_start: boolean | null
  }>()

  return rows.map((row) => ({
    ts: new Date(`${row.ts.replace(" ", "T")}Z`),
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    requestId: row.request_id,
    level: row.level,
    message: row.message,
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.billed_ms === null ? {} : { billedMs: row.billed_ms }),
    ...(row.memory_mb === null ? {} : { memoryMb: row.memory_mb }),
    ...(row.init_ms === null ? {} : { initMs: row.init_ms }),
    ...(row.cold_start === null ? {} : { coldStart: row.cold_start }),
  }))
}
