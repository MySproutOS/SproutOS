import { crudAuditLog } from "@lib/dao"
import { ANALYSIS_KIND, enqueue } from "@lib/jobs"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  analysisSchemaIdParam,
  analysisSchemaListResponse,
  analysisSchemaRequest,
  analysisSchemaResponse,
} from "./analysis.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * TASKS 38 and 39.
 *
 * Requesting an analysis enqueues a job and returns immediately: a clone, a walk of the tree, and
 * a model call over a large prompt take about a minute, and holding an HTTP connection open for
 * that is a timeout waiting to happen. The caller polls the row.
 *
 * The clone is unauthenticated, so this works on public repositories today without the GitHub App
 * — which is what TASK 39 is about.
 */
const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/analyses",
    describeRoute({
      description: "Lists the organization's repository analyses",
      responses: {
        200: {
          description: "Analyses",
          content: { "application/json": { schema: resolver(analysisSchemaListResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
      },
    }),
    requirePermission("project:read"),
    async (c) => {
      const rows = await db
        .selectFrom("repoAnalysis")
        .selectAll()
        .where("organizationId", "=", c.var.organization.id)
        .orderBy("createdAt", "desc")
        .limit(50)
        .execute()

      return c.json({ data: rows.map(present) })
    },
  )
  .post(
    "/:orgSlug/analyses",
    describeRoute({
      description: "Analyses a public repository to work out what it needs to run here",
      responses: {
        202: {
          description: "Queued",
          content: { "application/json": { schema: resolver(analysisSchemaResponse) } },
        },
        400: { description: "The project or listing is not this organization's", ...errorResponse },
        403: { description: "Caller lacks project:create", ...errorResponse },
      },
    }),
    // Analysis spends the organization's credit, so it needs the permission that creates things
    // rather than the one that reads them.
    requirePermission("project:create"),
    validator("json", analysisSchemaRequest),
    async (c) => {
      const body = c.req.valid("json")
      const organization = c.var.organization
      const ref = body.ref ?? "HEAD"

      if (body.projectId != null) {
        const owned = await db
          .selectFrom("project")
          .select("id")
          .where("id", "=", body.projectId)
          .where("organizationId", "=", organization.id)
          .where("deletedAt", "is", null)
          .executeTakeFirst()
        if (owned === undefined) {
          return throwBadRequest(c, "That project does not belong to this organization")
        }
      }

      /*
        Reuse a finished analysis rather than charging for it twice.

        Two people proposing the same popular project on the same day is the expected case, not an
        edge one, and the manifest describes a commit rather than a moment — so an existing result
        for the same repository and ref is the right answer, not a stale one.
      */
      const existing = await db
        .selectFrom("repoAnalysis")
        .selectAll()
        .where("upstreamOwner", "=", body.owner)
        .where("upstreamRepo", "=", body.repo)
        .where("ref", "=", ref)
        .where("status", "in", ["queued", "running", "succeeded"])
        .executeTakeFirst()

      if (existing !== undefined) return c.json(present(existing), 202)

      const analysisId = v7()
      await db
        .insertInto("repoAnalysis")
        .values({
          id: analysisId,
          organizationId: organization.id,
          requestedByUserId: c.var.user.id,
          projectId: body.projectId ?? null,
          storeListingId: body.storeListingId ?? null,
          upstreamOwner: body.owner,
          upstreamRepo: body.repo,
          ref,
          status: "queued",
        })
        .execute()

      await enqueue(db, {
        kind: ANALYSIS_KIND,
        organizationId: organization.id,
        payload: { analysisId },
        idempotencyKey: `${ANALYSIS_KIND}:${analysisId}`,
        // Two attempts: a failed analysis has usually failed for a reason retrying will not fix,
        // and every attempt costs the customer tokens.
        maxAttempts: 2,
      })

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "project:create",
        resourceSrn: srnFor("project", organization.id, "analysis", analysisId),
        after: { owner: body.owner, repo: body.repo, ref },
        ...auditContext(c),
      })

      const created = await db
        .selectFrom("repoAnalysis")
        .selectAll()
        .where("id", "=", analysisId)
        .executeTakeFirstOrThrow()

      return c.json(present(created), 202)
    },
  )
  .get(
    "/:orgSlug/analyses/:analysisId",
    describeRoute({
      description: "Reads one analysis. Poll this until status is no longer queued or running",
      responses: {
        200: {
          description: "Analysis",
          content: { "application/json": { schema: resolver(analysisSchemaResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such analysis", ...errorResponse },
      },
    }),
    requirePermission("project:read"),
    validator("param", analysisSchemaIdParam),
    async (c) => {
      const { analysisId } = c.req.valid("param")
      const row = await db
        .selectFrom("repoAnalysis")
        .selectAll()
        .where("id", "=", analysisId)
        .where("organizationId", "=", c.var.organization.id)
        .executeTakeFirst()

      if (row === undefined) return throwNotFound(c, "Analysis not found")
      return c.json(present(row))
    },
  )

type Row = {
  id: string
  status: string
  upstreamOwner: string
  upstreamRepo: string
  ref: string
  commitSha: string | null
  confidence: number | null
  manifest: unknown
  error: string | null
  costMicroUsd: unknown
  createdAt: Date
}

function present(row: Row) {
  return {
    id: row.id,
    status: row.status,
    owner: row.upstreamOwner,
    repo: row.upstreamRepo,
    ref: row.ref,
    commitSha: row.commitSha,
    confidence: row.confidence,
    // Stored as jsonb, so it arrives parsed. Null until the analysis finishes.
    manifest: (row.manifest ?? null) as null,
    error: row.error,
    costMicroUsd: String(row.costMicroUsd),
    createdAt: row.createdAt.toISOString(),
  }
}

export default app
