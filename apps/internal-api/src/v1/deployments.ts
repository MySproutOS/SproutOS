import { crudAuditLog, crudDeployment, fetchDeployment } from "@lib/dao"
import { PUBLISH_KINDS, enqueue } from "@lib/jobs"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
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
  /** Left over from the cluster, which chose a runtime class per workload. Lambda has none. */
  runtimeClass: string | null
  /** Why the deploy failed, when it failed after building. */
  failureReason: string | null
  createdAt: Date
  updatedAt: Date
}

function present(row: DeploymentRow, buildFailureReason: string | null = null) {
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
    /*
      Two reasons, because they answer different questions.

      `buildFailureReason` is "your image would not build" — a Dockerfile problem. `failureReason` is
      "your image built and would not run" — an application problem. Collapsing them into one field
      would leave a customer unable to tell which half is theirs.
    */
    failureReason: row.failureReason,
    buildFailureReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * The failure reason of each deployment's most recent build.
 *
 * `distinct on` is Postgres's "one row per group", and the order clause is what picks *which* row —
 * the leading key must match the distinct key or the result is arbitrary. A deployment retried
 * three times has three builds and only the last one's reason is the current answer.
 *
 * One query for the whole list rather than one per row, the same reason `enrich` in `projects.ts`
 * batches: a project with fifty deployments would otherwise make fifty round trips to render one
 * screen.
 */
async function buildFailureReasons(deploymentIds: readonly string[]): Promise<Map<string, string>> {
  if (deploymentIds.length === 0) return new Map()

  const rows = await db
    .selectFrom("deploymentBuild")
    .distinctOn("deploymentId")
    .select(["deploymentId", "failureReason"])
    .where("deploymentId", "in", [...deploymentIds])
    .where("failureReason", "is not", null)
    .orderBy("deploymentId")
    .orderBy("createdAt", "desc")
    .execute()

  return new Map(
    rows.flatMap((row) =>
      row.failureReason === null ? [] : [[row.deploymentId, row.failureReason]],
    ),
  )
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

      const reasons = await buildFailureReasons(rows.map((row) => row.id))

      return c.json({ data: rows.map((row) => present(row, reasons.get(row.id) ?? null)) })
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
          "failureReason",
          "createdAt",
          "updatedAt",
        ],
      )

      if (row === undefined) return throwNotFound(c, "Deployment not found")

      const reasons = await buildFailureReasons([row.id])

      return c.json(present(row, reasons.get(row.id) ?? null))
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
        .select(["id", "productionBranch", "scaleMode"])
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
        /*
          Copied from the project, not read from it later.

          A deployment is a historical fact. Reading the mode off the project at deploy time would
          let a settings change re-describe how a revision that already ran was configured — the
          same reasoning `runtime_class` carries.
        */
        scaleMode: project.scaleMode,
      })

      await enqueue(db, {
        kind: PUBLISH_KINDS.release,
        organizationId: c.var.organization.id,
        payload: { deploymentId: deployment.id },
        // Keyed on the deployment, so a retried request that already created a row does not queue
        // the same work twice.
        idempotencyKey: `${PUBLISH_KINDS.release}:${deployment.id}`,
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
