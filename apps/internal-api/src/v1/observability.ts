/* oxlint-disable no-await-in-loop -- stream queries, frames, checkpoints, and delays are ordered */
import {
  decodeRuntimeLogStreamCursor,
  issueIngestKey,
  MAX_LIMIT,
  observabilityConfigured,
  projectServices,
  queryRuntimeLogsAfter,
  queryRuntimeLogs,
  searchLogs,
  RUNTIME_LOG_RETENTION_DAYS,
  runtimeUsage,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwConflict, throwError, throwNotFound } from "../utils/http-exception"
import { ErrorCode } from "../utils/errors.enum"
import {
  observabilitySchemaKeyRequest,
  observabilitySchemaKeyResponse,
  observabilitySchemaLogFollowQuery,
  observabilitySchemaLogQuery,
  observabilitySchemaLogsResponse,
  observabilitySchemaOtlpQuery,
  observabilitySchemaOtlpResponse,
  observabilitySchemaProjectParam,
  observabilitySchemaStreamResponse,
} from "./observability.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** The default window a log page opens on. Long enough to see a deploy, short enough to be fast. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000
const LOG_STREAM_POLL_MS = 1_000
const LOG_STREAM_CONNECTION_MS = 25_000
const LOG_STREAM_PAGE_SIZE = 200
const LOG_STREAM_FRAME_BYTES = 512 * 1024
const LOG_STREAM_RECONNECT_WRITE_MS = 1_000

type RuntimeStreamLine = {
  ts: Date
  cursor: string
  level: string
  message: string
  requestId: string
  deploymentId: string
  durationMs?: number
  billedMs?: number
  memoryMb?: number
  initMs?: number
  coldStart?: boolean
}

/** Public so the protocol's exact versioned payload is unit-testable without ClickHouse. */
export function runtimeLogStreamEvent(line: RuntimeStreamLine) {
  return {
    schemaVersion: 1 as const,
    type: "log" as const,
    cursor: line.cursor,
    line: {
      timestamp: line.ts.toISOString(),
      cursor: line.cursor,
      level: line.level,
      message: line.message,
      requestId: line.requestId,
      deploymentId: line.deploymentId,
      durationMs: line.durationMs ?? null,
      billedMs: line.billedMs ?? null,
      memoryMb: line.memoryMb ?? null,
      initMs: line.initMs ?? null,
      coldStart: line.coldStart ?? null,
    },
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

function beforeAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () =>
    signal.reason instanceof Error ? signal.reason : new Error("log stream operation aborted")
  if (signal.aborted) return Promise.reject(reason())
  return new Promise((resolve, reject) => {
    const aborted = () => {
      reject(reason())
    }
    signal.addEventListener("abort", aborted, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted)
    })
  })
}

type StreamErrorEvent = { event: "error"; data: string }

/**
 * The terminal store-error frame is best effort, but it must not outlive the connection deadline
 * when a downstream client stops reading and the response writer applies backpressure.
 */
export async function writeRuntimeLogStreamStoreError(
  write: (event: StreamErrorEvent) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  await beforeAbort(
    write({
      event: "error",
      data: JSON.stringify({
        schemaVersion: 1,
        type: "error",
        code: "log_store_unavailable",
        message: "The log store did not answer",
        retryable: true,
      }),
    }),
    signal,
  ).catch(() => undefined)
}

function responseBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/*
  Where a customer points their OTLP exporter.

  `NEXT_PUBLIC_API_URL`, which is what every other reader of the API's own address uses — the
  OpenAPI server URL in `index.ts`, `apiBase()` in `oauth.ts`, and the generated client. This read
  `PUBLIC_API_URL`, a name nothing sets and nothing else reads, so it always took the fallback and
  the Ingest key dialog offered `http://localhost:3001/v1/otlp` to a customer in production.

  The fallback is the tell: a variable that is *usually* wrong fails loudly on the first request,
  and a variable with a plausible localhost default fails by handing someone an address that is
  syntactically fine and points at their own machine.
*/
function ingestEndpoint(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  return `${base.replace(/\/$/, "")}/v1/otlp`
}

/**
 * Reading a project's logs, and managing the key its exporters use.
 *
 * Both are scoped to one project, and the project id comes from the path where `requirePermission`
 * can see it. Nothing here takes a project id from a query string or a body — that would be an
 * identifier the RBAC check did not look at.
 */
/**
 * Turns a failure to reach the log store into something that says so.
 *
 * Both observability routes answered a bare `500 Internal Server Error` when ClickHouse could not
 * be queried, which is the least useful thing they could have said: the store is on another host,
 * behind an IP allowlist, with its own credentials and its own database name, and any of those
 * being wrong produces exactly this response. Worse, the one tool for finding out *which* is the
 * log viewer — so the failure hid the only instrument for diagnosing it.
 *
 * 502, because the request was fine and something it depends on was not. The cause is included:
 * every caller here has already passed `observability:logs:read` on their own project, so this
 * reveals nothing they should not see, and without it the next person is exactly where this one
 * was. `CLICKHOUSE_URL` is a hostname and carries no credential; the password is a separate
 * variable and never appears in a client error.
 */
function logStoreFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`[observability] the log store did not answer: ${detail}`)

  return `The log store did not answer: ${detail.slice(0, 300)}`
}

const observability: Hono = new Hono()
observability.use("*", authMiddleware)

observability
  .get(
    "/:orgSlug/projects/:projectId/logs",
    describeRoute({
      description: "Search a project's logs",
      responses: {
        200: {
          description: "A page of log lines, newest first",
          content: {
            "application/json": { schema: resolver(observabilitySchemaLogsResponse) },
          },
        },
        403: { description: "Caller lacks observability:logs:read", ...errorResponse },
        503: { description: "Log storage is not configured", ...errorResponse },
      },
    }),
    requirePermission("observability:logs:read", paramResource("project", "project", "projectId")),
    validator("param", observabilitySchemaProjectParam),
    validator("query", observabilitySchemaLogQuery),
    async (c) => {
      if (!observabilityConfigured()) {
        return throwConflict(c, "Log storage is not configured on this deployment")
      }
      const { projectId } = c.req.valid("param")
      const query = c.req.valid("query")

      const project = await ownedProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")

      const limit = Number(query.limit)
      const pageSize = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : 100

      /*
        `before` is a timestamp, not an opaque id.

        Paging by `ts` is exact enough here because the page asks for strictly older rows than the
        last one it holds, and `runtime_log` is ordered by `(project_id, ts, request_id)` — so this
        is a seek rather than a scan. Two lines in the same millisecond can straddle a page
        boundary; that is a duplicate at worst, never a gap, and a viewer showing one line twice is
        a much smaller problem than one silently dropping it.
      */
      const until = query.before ?? query.until ?? new Date().toISOString()
      const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString()

      try {
        const rows = await queryRuntimeLogs({
          projectId,
          since: new Date(since),
          until: new Date(until),
          limit: pageSize,
          ...(query.search === undefined || query.search === "" ? {} : { search: query.search }),
          ...(query.level === undefined || query.level === "" ? {} : { level: query.level }),
        })

        const lines = rows.map((row) => ({
          timestamp: row.ts.toISOString(),
          cursor: row.ts.toISOString(),
          level: row.level,
          message: row.message,
          requestId: row.requestId,
          deploymentId: row.deploymentId,
          durationMs: row.durationMs ?? null,
          billedMs: row.billedMs ?? null,
          memoryMb: row.memoryMb ?? null,
          initMs: row.initMs ?? null,
          coldStart: row.coldStart ?? null,
        }))

        /*
          A full page implies there may be more; a short one is the end.

          Not a count query. "Is there another page" costs a second scan to answer exactly, and the
          only consequence of guessing high is one more request that comes back empty.
        */
        const nextBefore =
          lines.length < pageSize ? null : (lines[lines.length - 1]?.cursor ?? null)

        return c.json({ lines, nextBefore })
      } catch (error) {
        return throwError(c, 502, ErrorCode.ServiceUnavailable, logStoreFailure(error))
      }
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/logs/follow",
    requirePermission("observability:logs:read", paramResource("project", "project", "projectId")),
    validator("param", observabilitySchemaProjectParam),
    validator("query", observabilitySchemaLogFollowQuery),
    async (c) => {
      if (!observabilityConfigured()) {
        return throwConflict(c, "Log storage is not configured on this deployment")
      }
      const { projectId } = c.req.valid("param")
      const query = c.req.valid("query")
      if ((await ownedProject(c.var.organization.id, projectId)) === undefined) {
        return throwNotFound(c, "Project not found")
      }

      const queryCursor = query.cursor
      const headerCursor = c.req.header("Last-Event-ID")
      if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
        return throwError(c, 400, ErrorCode.InvalidInput, "Log resume cursors do not match")
      }
      const resumeCursor = queryCursor ?? headerCursor

      let after
      try {
        after = resumeCursor === undefined ? undefined : decodeRuntimeLogStreamCursor(resumeCursor)
      } catch {
        return throwError(c, 400, ErrorCode.InvalidInput, "Invalid log resume cursor")
      }
      const parsedSince = query.since === undefined ? undefined : new Date(query.since)
      if (parsedSince !== undefined && Number.isNaN(parsedSince.getTime())) {
        return throwError(c, 400, ErrorCode.InvalidInput, "Invalid log start time")
      }
      // A cursor is authoritative. `since` is only the initial checkpoint and must not be allowed
      // to move a resumed stream forward past records it has not delivered.
      const since =
        after === undefined
          ? (parsedSince ?? new Date(Date.now() - DEFAULT_WINDOW_MS))
          : new Date(0)
      const requestedLimit = Number(query.limit)
      const pageSize =
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, 500)
          : LOG_STREAM_PAGE_SIZE

      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")

      const response = streamSSE(c, async (stream) => {
        const requestSignal = c.req.raw.signal
        const deadlineController = new AbortController()
        const abortForRequest = () => {
          deadlineController.abort(requestSignal.reason)
        }
        requestSignal.addEventListener("abort", abortForRequest, { once: true })
        const deadlineTimer = setTimeout(() => {
          deadlineController.abort(new Error("log stream connection deadline"))
        }, LOG_STREAM_CONNECTION_MS)
        const signal = deadlineController.signal
        const deadline = Date.now() + LOG_STREAM_CONNECTION_MS
        let cursor = after

        try {
          await beforeAbort(
            stream.writeSSE({
              event: "ready",
              retry: LOG_STREAM_POLL_MS,
              data: JSON.stringify({ schemaVersion: 1, type: "ready" }),
            }),
            signal,
          )

          while (!signal.aborted && Date.now() < deadline) {
            const lines = await queryRuntimeLogsAfter({
              projectId,
              since,
              ...(cursor === undefined ? {} : { after: cursor }),
              ...(query.search === undefined || query.search === ""
                ? {}
                : { search: query.search }),
              ...(query.level === undefined || query.level === "" ? {} : { level: query.level }),
              limit: pageSize,
              signal,
            })

            for (const line of lines) {
              if (signal.aborted) return
              const data = JSON.stringify(runtimeLogStreamEvent(line))
              if (responseBytes(data) > LOG_STREAM_FRAME_BYTES) {
                await beforeAbort(
                  stream.writeSSE({
                    event: "error",
                    data: JSON.stringify({
                      schemaVersion: 1,
                      type: "error",
                      code: "log_record_too_large",
                      message: "A stored log record exceeds the streaming limit",
                      retryable: false,
                    }),
                  }),
                  signal,
                )
                return
              }
              await beforeAbort(stream.writeSSE({ event: "log", id: line.cursor, data }), signal)
              cursor = decodeRuntimeLogStreamCursor(line.cursor)
            }

            // Full pages are drained immediately. Sleeping between them recreates the burst gap
            // this forward-only endpoint exists to prevent.
            if (lines.length < pageSize) {
              await beforeAbort(
                stream.writeSSE({
                  event: "heartbeat",
                  data: JSON.stringify({ schemaVersion: 1, type: "heartbeat" }),
                }),
                signal,
              )
              await abortableSleep(LOG_STREAM_POLL_MS, signal)
            }
          }
        } catch (error) {
          if (!signal.aborted) {
            const detail = error instanceof Error ? error.message : String(error)
            console.error(`[observability] runtime log stream query failed: ${detail}`)
            await writeRuntimeLogStreamStoreError((event) => stream.writeSSE(event), signal)
            return
          }
        } finally {
          clearTimeout(deadlineTimer)
          requestSignal.removeEventListener("abort", abortForRequest)
        }

        if (!requestSignal.aborted) {
          const reconnectController = new AbortController()
          const reconnectTimer = setTimeout(() => {
            reconnectController.abort(new Error("log stream reconnect write deadline"))
          }, LOG_STREAM_RECONNECT_WRITE_MS)
          await beforeAbort(
            stream.writeSSE({
              event: "reconnect",
              data: JSON.stringify({
                schemaVersion: 1,
                type: "reconnect",
                retryAfterMs: LOG_STREAM_POLL_MS,
              }),
            }),
            reconnectController.signal,
          ).catch(() => undefined)
          clearTimeout(reconnectTimer)
        }
      })
      // `streamSSE` sets `no-cache` after context headers are applied. Runtime logs are tenant
      // data, so replace it on the final response rather than allowing a shared cache to store it.
      c.header("Cache-Control", "no-store, no-transform")
      const headers = new Headers(response.headers)
      headers.set("Cache-Control", "no-store, no-transform")
      return new Response(response.body, { status: response.status, headers })
    },
  )
  /*
    The second source, for projects that send OpenTelemetry.

    A separate route rather than a `source` parameter on the one above, because the two return
    genuinely different rows — `trace_id` and attribute maps here, Lambda's billing fields there —
    and a union response would give the generated client a type every caller has to narrow before
    it can read anything. Two routes, two honest shapes.
  */
  .get(
    "/:orgSlug/projects/:projectId/logs/otlp",
    describeRoute({
      description: "Search the logs a project's own OpenTelemetry exporter sent",
      responses: {
        200: {
          description: "A page of OTLP records, newest first",
          content: { "application/json": { schema: resolver(observabilitySchemaOtlpResponse) } },
        },
        403: { description: "Caller lacks observability:logs:read", ...errorResponse },
        503: { description: "Log storage is not configured", ...errorResponse },
      },
    }),
    requirePermission("observability:logs:read", paramResource("project", "project", "projectId")),
    validator("param", observabilitySchemaProjectParam),
    validator("query", observabilitySchemaOtlpQuery),
    async (c) => {
      if (!observabilityConfigured()) {
        return throwConflict(c, "Log storage is not configured on this deployment")
      }
      const { projectId } = c.req.valid("param")
      const query = c.req.valid("query")

      const project = await ownedProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")

      const until = query.until ?? new Date().toISOString()
      const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString()
      const minSeverity = Number(query.minSeverity)
      const limit = Number(query.limit)

      try {
        const result = await searchLogs({
          projectId,
          since,
          until,
          limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : 100,
          ...(query.search === undefined || query.search === "" ? {} : { search: query.search }),
          ...(Number.isFinite(minSeverity) && minSeverity > 0 ? { minSeverity } : {}),
          ...(query.service === undefined || query.service === ""
            ? {}
            : { service: query.service }),
          ...(query.traceId === undefined || query.traceId === ""
            ? {}
            : { traceId: query.traceId }),
          ...(query.before === undefined ? {} : { before: query.before }),
        })

        return c.json(result)
      } catch (error) {
        return throwError(c, 502, ErrorCode.ServiceUnavailable, logStoreFailure(error))
      }
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/observability",
    describeRoute({
      description: "A project's ingest settings and usage",
      responses: {
        200: {
          description: "Stream",
          content: {
            "application/json": { schema: resolver(observabilitySchemaStreamResponse) },
          },
        },
        403: { description: "Caller lacks observability:logs:read", ...errorResponse },
      },
    }),
    requirePermission("observability:logs:read", paramResource("project", "project", "projectId")),
    validator("param", observabilitySchemaProjectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const project = await ownedProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")

      const stream = await db
        .selectFrom("observabilityStream")
        .select(["id", "retentionDays"])
        .where("projectId", "=", projectId)
        .executeTakeFirst()

      /*
        Three days, and not the stream's retention.

        The viewer shows `runtime_log`, whose TTL is fixed for everyone —
        `RUNTIME_LOG_RETENTION_DAYS`, the same constant the DDL is built from. `observability_stream`
        carries a *per-project* retention, but that governs `log_record`, which is the table a
        customer's own OpenTelemetry exporter writes into. Reporting the stream's number under a
        list of runtime lines told people their logs were kept 7 days when the table drops them
        after 3.
      */
      const retentionDays = RUNTIME_LOG_RETENTION_DAYS
      const since = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

      /*
        Usage and the service list come from the log store, and only if it is configured.

        A deployment without ClickHouse should still be able to show a project's settings and hand
        out an ingest key — the settings live in Postgres. Failing the whole page because the store
        is absent would make the one screen that explains how to send logs the screen you cannot
        open until logs are already working.
      */
      let usage: Awaited<ReturnType<typeof runtimeUsage>> = { records: 0, bytes: 0 }
      let services: Awaited<ReturnType<typeof projectServices>> = []

      if (observabilityConfigured()) {
        try {
          ;[usage, services] = await Promise.all([
            runtimeUsage(projectId, since),
            // Still `log_record`'s, and empty unless the project actually sends OTLP. Runtime lines
            // have no service name — they are one function's output — so this dropdown simply does
            // not appear for them, which is the right behaviour rather than a gap.
            projectServices(projectId, since),
          ])
        } catch (error) {
          return throwError(c, 502, ErrorCode.ServiceUnavailable, logStoreFailure(error))
        }
      }

      return c.json({
        streamId: stream?.id ?? null,
        retentionDays,
        endpoint: ingestEndpoint(),
        services,
        usage,
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/observability/key",
    describeRoute({
      description: "Issue or rotate a project's OTLP ingest key",
      responses: {
        201: {
          description: "The key, shown once",
          content: {
            "application/json": { schema: resolver(observabilitySchemaKeyResponse) },
          },
        },
        403: { description: "Caller lacks observability:stream:manage", ...errorResponse },
      },
    }),
    requirePermission(
      // Not `observability:logs:read`: rotating invalidates the old key, so every exporter the
      // project has deployed stops sending until it is redeployed. That is an admin action.
      "observability:stream:manage",
      paramResource("project", "project", "projectId"),
    ),
    validator("param", observabilitySchemaProjectParam),
    validator("json", observabilitySchemaKeyRequest),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { retentionDays } = c.req.valid("json")

      const project = await ownedProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")

      const existing = await db
        .selectFrom("observabilityStream")
        .select("retentionDays")
        .where("projectId", "=", projectId)
        .executeTakeFirst()

      const storedDays = existing?.retentionDays ?? 7
      const days =
        retentionDays ??
        (storedDays === 7 || storedDays === 30 || storedDays === 90 ? storedDays : 7)
      const issued = await issueIngestKey(db, projectId, days)

      return c.json({ ...issued, endpoint: ingestEndpoint(), retentionDays: days }, 201)
    },
  )

/** The join that *is* the tenancy check: a project reached through the caller's organization. */
async function ownedProject(organizationId: string, projectId: string) {
  return await db
    .selectFrom("project")
    .select("id")
    .where("id", "=", projectId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
}

export default observability
