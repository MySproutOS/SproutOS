import {
  issueIngestKey,
  MAX_LIMIT,
  observabilityConfigured,
  projectServices,
  projectUsage,
  searchLogs,
  type RetentionDays,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwConflict, throwNotFound } from "../utils/http-exception"
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

function ingestEndpoint(): string {
  const base = process.env.PUBLIC_API_URL ?? "http://localhost:3001"
  return `${base.replace(/\/$/, "")}/v1/otlp`
}

/**
 * Reading a project's logs, and managing the key its exporters use.
 *
 * Both are scoped to one project, and the project id comes from the path where `requirePermission`
 * can see it. Nothing here takes a project id from a query string or a body — that would be an
 * identifier the RBAC check did not look at.
 */
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

      const until = query.until ?? new Date().toISOString()
      const since = query.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString()

      const minSeverity = Number(query.minSeverity)
      const limit = Number(query.limit)

      const result = await searchLogs({
        projectId,
        since,
        until,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : 100,
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(Number.isFinite(minSeverity) && minSeverity > 0 ? { minSeverity } : {}),
        ...(query.service === undefined ? {} : { service: query.service }),
        ...(query.traceId === undefined ? {} : { traceId: query.traceId }),
        ...(query.before === undefined ? {} : { before: query.before }),
      })

      return c.json(result)
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

      const retentionDays = Number(stream?.retentionDays ?? 7)
      const since = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

      /*
        Usage and the service list come from the log store, and only if it is configured.

        A deployment without ClickHouse should still be able to show a project's settings and hand
        out an ingest key — the settings live in Postgres. Failing the whole page because the store
        is absent would make the one screen that explains how to send logs the screen you cannot
        open until logs are already working.
      */
      const [usage, services] = observabilityConfigured()
        ? await Promise.all([projectUsage(projectId, since), projectServices(projectId, since)])
        : [{ records: 0, bytes: 0 }, []]

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
