import {
  issueIngestKey,
  MAX_LIMIT,
  observabilityConfigured,
  projectServices,
  queryRuntimeLogs,
  RUNTIME_LOG_RETENTION_DAYS,
  runtimeUsage,
  type RetentionDays,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { Hono } from "hono"
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
  observabilitySchemaLogQuery,
  observabilitySchemaLogsResponse,
  observabilitySchemaProjectParam,
  observabilitySchemaStreamResponse,
} from "./observability.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** The default window a log page opens on. Long enough to see a deploy, short enough to be fast. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000

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

      const days = (retentionDays ?? Number(existing?.retentionDays ?? 7)) as RetentionDays
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
