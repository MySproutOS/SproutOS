import { crudAuditLog, crudDeployment, fetchDeployment } from "@lib/dao"
import {
  functionName,
  pointAlias,
  publishLiveDeployment,
  publishRoute,
  type Route,
} from "@lib/lambda"
import { Redis } from "ioredis"
import {
  PUBLISH_KINDS,
  enqueue,
  pointStaticSite,
  withProjectLock,
  staticPlatformFromEnv,
} from "@lib/jobs"
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

/*
  Built on first use, never at import.

  A `new Redis(...)` at module scope opens a connection as a side effect of importing the route
  registry, which is what kept the OpenAPI generator's process alive until it timed out — the same
  trap `publish.ts` documents.
*/
let valkeyClient: Redis | undefined
function rollbackValkey(): Redis {
  valkeyClient ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return valkeyClient
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
  hostname: string | null
  preset: string
  lambdaVersion: string | null
  migrationStatus: string | null
  migrationOutput: string | null
  createdByUserId: string | null
  gitMessage: string | null
  imageUri: string | null
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
    hostname: row.hostname,
    preset: row.preset,
    lambdaVersion: row.lambdaVersion,
    migrationStatus: row.migrationStatus,
    migrationOutput: row.migrationOutput,
    createdByUserId: row.createdByUserId,
    gitMessage: row.gitMessage,
    imageUri: row.imageUri,
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
          "hostname",
          "preset",
          "lambdaVersion",
          "migrationStatus",
          "migrationOutput",
          "createdByUserId",
          "gitMessage",
          "imageUri",
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

  .post(
    "/:orgSlug/deployments/:deploymentId/rollback",
    describeRoute({
      description: "Point the project's live alias back at this deployment. No build, no upload.",
      responses: {
        200: {
          description: "Rolled back",
          content: { "application/json": { schema: resolver(deploymentSchemaResponse) } },
        },
        400: { description: "This deployment cannot be rolled back to", ...errorResponse },
        403: { description: "Caller lacks deployment:write", ...errorResponse },
        404: { description: "No such deployment in this organization", ...errorResponse },
      },
    }),
    requirePermission("deployment:write"),
    async (c) => {
      const found = await fetchDeployment(db).withProject(c.req.param("deploymentId"))
      if (found === undefined) return throwNotFound(c, "Deployment not found")

      const { deployment, project } = found
      if (project.organizationId !== c.var.organization.id) {
        return throwNotFound(c, "Deployment not found")
      }

      /*
        Three guards, each for a different way this would otherwise fail after the alias moved.

        No `lambda_version` means there is nothing to point at — the deploy never got as far as
        publishing one. A preview has its own hostname and pointing production at it would serve a
        pull request to customers. A deployment that is not `ready` never served, so "rolling back"
        to it would be a first release wearing the word rollback.
      */
      if (deployment.kind !== "production") {
        return throwBadRequest(c, "Only a production deployment can serve production traffic.")
      }
      if (deployment.status !== "ready") {
        return throwBadRequest(
          c,
          `That deployment is ${deployment.status}, so it has never served traffic.`,
        )
      }

      const hostname = deployment.hostname
      if (hostname === null) {
        return throwBadRequest(c, "That deployment has no hostname recorded.")
      }

      const valkey = rollbackValkey()
      return withProjectLock(
        db,
        project.id,
        async () => {
          const lockedProject = await db
            .selectFrom("project")
            .leftJoin(
              "deployment as liveDeployment",
              "liveDeployment.id",
              "project.liveDeploymentId",
            )
            .select([
              "project.deletedAt",
              "project.liveDeploymentId",
              "liveDeployment.id as liveId",
              "liveDeployment.preset as livePreset",
              "liveDeployment.hostname as liveHostname",
              "liveDeployment.staticDigest as liveStaticDigest",
              "liveDeployment.lambdaVersion as liveLambdaVersion",
            ])
            .where("project.id", "=", project.id)
            .executeTakeFirst()
          if (lockedProject === undefined || lockedProject.deletedAt !== null) {
            return throwNotFound(c, "Project not found")
          }
          if (lockedProject.liveId === null) {
            return throwBadRequest(c, "Rollback requires a currently live production deployment.")
          }
          if (
            lockedProject.liveId !== null &&
            (lockedProject.livePreset === "static") !== (deployment.preset === "static")
          ) {
            return throwBadRequest(
              c,
              "A project cannot switch between static and serverless serving modes.",
            )
          }

          const restorePreviousLive = async (): Promise<void> => {
            if (
              lockedProject.liveId === null ||
              lockedProject.liveHostname === null ||
              lockedProject.livePreset === null
            ) {
              return
            }
            if (lockedProject.livePreset === "static") {
              if (lockedProject.liveStaticDigest === null) return
              const platform = staticPlatformFromEnv()
              await pointStaticSite(platform, {
                hostname: lockedProject.liveHostname,
                prefix: `${project.id}/${lockedProject.liveStaticDigest}`,
                tenantZoneId: platform.tenantZoneId,
                distributionDomain: platform.distributionDomain,
                keyValueStoreArn: platform.keyValueStoreArn,
              })
            } else {
              if (lockedProject.liveLambdaVersion === null) return
              const { LambdaClient } = await import("@aws-sdk/client-lambda")
              const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" })
              const aliasArn = await pointAlias(
                lambda,
                functionName(project.id),
                lockedProject.liveLambdaVersion,
              )
              const route: Route = {
                arn: aliasArn,
                projectId: project.id,
                organizationId: project.organizationId,
                deploymentId: lockedProject.liveId,
              }
              await publishRoute(valkey, lockedProject.liveHostname, route)
              const domains = await db
                .selectFrom("customDomain")
                .select("hostname")
                .where("projectId", "=", project.id)
                .where("status", "=", "active")
                .where("deletedAt", "is", null)
                .execute()
              for (const domain of domains) await publishRoute(valkey, domain.hostname, route)
            }
            await publishLiveDeployment(valkey, project.id, lockedProject.liveId)
            await db
              .updateTable("project")
              .set({ liveDeploymentId: lockedProject.liveId, updatedAt: new Date() })
              .where("id", "=", project.id)
              .execute()
          }

          let trafficCommitted = false
          try {
            if (deployment.preset === "static") {
              if (deployment.staticDigest === null) {
                return throwBadRequest(c, "That static deployment has no content digest recorded.")
              }
              const platform = staticPlatformFromEnv()
              await pointStaticSite(platform, {
                hostname,
                prefix: `${project.id}/${deployment.staticDigest}`,
                tenantZoneId: platform.tenantZoneId,
                distributionDomain: platform.distributionDomain,
                keyValueStoreArn: platform.keyValueStoreArn,
              })
              await publishLiveDeployment(valkey, project.id, deployment.id)
              await db
                .updateTable("project")
                .set({ liveDeploymentId: deployment.id, updatedAt: new Date() })
                .where("id", "=", project.id)
                .execute()
              trafficCommitted = true
              await crudAuditLog(db).record({
                organizationId: c.var.organization.id,
                actorUserId: c.var.user.id,
                action: "deployment:write",
                resourceSrn: srnFor("compute", c.var.organization.id, "deployment", deployment.id),
                after: { rolledBackTo: deployment.id, staticDigest: deployment.staticDigest },
                ...auditContext(c),
              })
              const reasons = await buildFailureReasons([deployment.id])
              return c.json(present(deployment, reasons.get(deployment.id) ?? null))
            }

            if (deployment.lambdaVersion === null) {
              return throwBadRequest(
                c,
                "That deployment never published a version, so there is nothing to roll back to.",
              )
            }

            /*
        The alias move is the rollback. `pointAlias` is one API call and the old version was never
        deleted, which is what makes this instant rather than a rebuild.
      */
            const { LambdaClient } = await import("@aws-sdk/client-lambda")
            const lambda = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" })
            const aliasArn = await pointAlias(
              lambda,
              functionName(project.id),
              deployment.lambdaVersion,
            )

            /*
        Then the route, so the router resolves this deployment rather than the one it replaced.

        Republished rather than left alone: the route's value carries `deploymentId`, which is what
        attributes a request's cost and its logs. Leaving the old value would bill this traffic to
        the release that is no longer serving.
      */
            const route: Route = {
              arn: aliasArn,
              projectId: project.id,
              organizationId: project.organizationId,
              deploymentId: deployment.id,
            }
            await publishRoute(valkey, hostname, route)
            const domains = await db
              .selectFrom("customDomain")
              .select("hostname")
              .where("projectId", "=", project.id)
              .where("status", "=", "active")
              .where("deletedAt", "is", null)
              .execute()

            for (const domain of domains) {
              // eslint-disable-next-line no-await-in-loop -- a handful per project, same as `publish.ts`.
              await publishRoute(valkey, domain.hostname, route)
            }

            await publishLiveDeployment(valkey, project.id, deployment.id)

            await db
              .updateTable("project")
              .set({ liveDeploymentId: deployment.id, updatedAt: new Date() })
              .where("id", "=", project.id)
              .execute()
            trafficCommitted = true

            await crudAuditLog(db).record({
              organizationId: c.var.organization.id,
              actorUserId: c.var.user.id,
              action: "deployment:write",
              resourceSrn: srnFor("compute", c.var.organization.id, "deployment", deployment.id),
              after: { rolledBackTo: deployment.id, lambdaVersion: deployment.lambdaVersion },
              ...auditContext(c),
            })

            const reasons = await buildFailureReasons([deployment.id])
            return c.json(present(deployment, reasons.get(deployment.id) ?? null))
          } catch (error) {
            if (!trafficCommitted) await restorePreviousLive()
            throw error
          }
        },
        { maxWaitMs: 30_000 },
      )
    },
  )

export default app
