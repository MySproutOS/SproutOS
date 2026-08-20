import { crudAuditLog, crudDeployment, fetchDeployment } from "@lib/dao"
import { DEPLOY_KINDS, enqueue } from "@lib/jobs"
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
  deploymentSchemaListResponse,
  deploymentSchemaRequest,
  deploymentSchemaResponse,
} from "./deployments.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

type DeploymentRow = {
  id: string
  projectId: string
  kind: string
  status: string
  gitSha: string
  gitRef: string | null
  prNumber: number | null
  url: string | null
  imageUri: string | null
  knativeRevision: string | null
  runtimeClass: string
  createdAt: Date
  updatedAt: Date
}

function present(row: DeploymentRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    gitSha: row.gitSha,
    gitRef: row.gitRef,
    prNumber: row.prNumber,
    url: row.url,
    imageUri: row.imageUri,
    knativeRevision: row.knativeRevision,
    runtimeClass: row.runtimeClass,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Deployments (phase 10).
 *
 * Creating one enqueues a job and returns `202` with the row. A deploy is a build, an image push
 * and a revision coming up — minutes, not milliseconds — so the caller polls rather than holding a
 * connection open for it. The row *is* the status.
 */
const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/projects/:projectId/deployments",
    describeRoute({
      description: "Lists a project's deployments, newest first",
      responses: {
        200: {
          description: "Deployments",
          content: { "application/json": { schema: resolver(deploymentSchemaListResponse) } },
        },
        403: { description: "Caller lacks deployment:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    requirePermission("deployment:read"),
    async (c) => {
      const projectId = c.req.param("projectId")

      // The project is looked up in the caller's organization first. `requirePermission` authorizes
      // against an SRN built from the resolved organization plus this unverified parameter, so a
      // project id from somewhere else produces a valid SRN here and passes the check.
      const project = await db
        .selectFrom("project")
        .select("id")
        .where("id", "=", projectId)
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .executeTakeFirst()

      if (project === undefined) return throwNotFound(c, "Project not found")

      const rows = await db
        .selectFrom("deployment")
        .selectAll()
        .where("projectId", "=", project.id)
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "desc")
        .limit(50)
        .execute()

      return c.json({ data: rows.map(present) })
    },
  )
  .get(
    "/:orgSlug/deployments/:deploymentId",
    describeRoute({
      description: "Reads one deployment",
      responses: {
        200: {
          description: "Deployment",
          content: { "application/json": { schema: resolver(deploymentSchemaResponse) } },
        },
        403: { description: "Caller lacks deployment:read", ...errorResponse },
        404: { description: "No such deployment in this organization", ...errorResponse },
      },
    }),
    requirePermission("deployment:read"),
    async (c) => {
      const row = await fetchDeployment(db).getInOrganization(
        c.var.organization.id,
        c.req.param("deploymentId"),
        [
          "id",
          "projectId",
          "kind",
          "status",
          "gitSha",
          "gitRef",
          "prNumber",
          "url",
          "imageUri",
          "knativeRevision",
          "runtimeClass",
          "createdAt",
          "updatedAt",
        ],
      )

      if (row === undefined) return throwNotFound(c, "Deployment not found")

      return c.json(present(row))
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/deployments",
    describeRoute({
      description: "Deploys a commit, returning immediately with the row to poll",
      responses: {
        202: {
          description: "Queued",
          content: { "application/json": { schema: resolver(deploymentSchemaResponse) } },
        },
        400: { description: "A preview needs a PR number", ...errorResponse },
        403: { description: "Caller lacks deployment:write", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    requirePermission("deployment:write"),
    validator("json", deploymentSchemaRequest),
    async (c) => {
      const body = c.req.valid("json")
      const projectId = c.req.param("projectId")

      const project = await db
        .selectFrom("project")
        .select(["id", "productionBranch"])
        .where("id", "=", projectId)
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .executeTakeFirst()

      if (project === undefined) return throwNotFound(c, "Project not found")

      const kind = body.kind ?? "production"

      // A preview with no PR number has no hostname it can be reached at — `pr-null--myapp` would
      // be a real host pointing at a real deployment. Rejected here rather than discovered by the
      // renderer, where the only symptom is a strange URL.
      if (kind === "preview" && (body.prNumber === null || body.prNumber === undefined)) {
        return throwBadRequest(c, "A preview deployment needs a prNumber")
      }

      const deployment = await crudDeployment(db).create({
        id: v7(),
        projectId: project.id,
        kind,
        gitSha: body.gitSha,
        gitRef: body.gitRef ?? null,
        prNumber: kind === "preview" ? (body.prNumber ?? null) : null,
        status: "queued",
      })

      await enqueue(db, {
        kind: DEPLOY_KINDS.revision,
        organizationId: c.var.organization.id,
        payload: { deploymentId: deployment.id },
        // Keyed on the deployment, so a retried request that already created a row does not queue
        // the same work twice.
        idempotencyKey: `${DEPLOY_KINDS.revision}:${deployment.id}`,
      })

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "deployment:write",
        resourceSrn: srnFor("compute", c.var.organization.id, "deployment", deployment.id),
        after: { gitSha: body.gitSha, kind, prNumber: deployment.prNumber },
        ...auditContext(c),
      })

      return c.json(present(deployment), 202)
    },
  )

export default app
