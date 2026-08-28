import { fetchAndroidApp, fetchAndroidSignerJob, fetchProject, fetchRepository } from "@lib/dao"
import { createGitHubClient, organizationGitHubCredential } from "@lib/github"
import { ensureAndroidSetup, recordVerifiedSetupCommit } from "@lib/jobs"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwConflict, throwNotFound } from "../utils/http-exception"
import { validator } from "../utils/validator"
import {
  androidAppSchemaParam,
  androidAppSchemaResponse,
  androidAppSchemaVerifyRequest,
} from "./android-apps.serializer"

const errorResponse = { content: { "application/json": { schema: resolver(ErrorSchemaResponse) } } }

async function status(organizationId: string, projectId: string) {
  const project = await fetchProject(db).getInOrganization(organizationId, projectId, ["id"])
  if (project === undefined) return undefined
  const android = await fetchAndroidApp(db).getForProject(projectId, [
    "id",
    "packageName",
    "developerConsoleAccount",
    "developerConsoleState",
    "developerConsoleProviderState",
    "developerConsoleCheckAttempts",
    "developerConsoleLastCheckedAt",
    "developerConsoleNextCheckAt",
    "developerConsoleLastFailure",
    "certificateSha256",
    "verifiedSetupCommit",
    "latestGoodDeploymentId",
    "lastAcceptedVersionCode",
    "lastError",
  ])
  if (android === undefined) return undefined
  const jobs = await fetchAndroidSignerJob(db).listForApp(android.id, [
    "id",
    "kind",
    "state",
    "error",
    "createdAt",
  ])
  return {
    androidAppId: android.id,
    packageName: android.packageName,
    state:
      android.lastError !== null || android.developerConsoleState === "failed"
        ? ("failed" as const)
        : android.developerConsoleState === "registered" && android.verifiedSetupCommit !== null
          ? ("ready" as const)
          : android.certificateSha256 !== null
            ? ("ready_for_signing" as const)
            : ("configuring" as const),
    developerConsoleState: android.developerConsoleState,
    developerConsoleAccount: android.developerConsoleAccount,
    developerConsoleProviderState: android.developerConsoleProviderState,
    developerConsoleCheckAttempts: android.developerConsoleCheckAttempts,
    developerConsoleLastCheckedAt: android.developerConsoleLastCheckedAt?.toISOString() ?? null,
    developerConsoleNextCheckAt: android.developerConsoleNextCheckAt.toISOString(),
    developerConsoleLastFailure: android.developerConsoleLastFailure,
    certificateSha256: android.certificateSha256,
    verifiedSetupCommit: android.verifiedSetupCommit,
    latestGoodDeploymentId: android.latestGoodDeploymentId,
    lastAcceptedVersionCode: android.lastAcceptedVersionCode,
    lastError: android.lastError,
    jobs: jobs.map((job) => ({ ...job, createdAt: job.createdAt.toISOString() })),
  }
}

const app = new Hono()
  .use(authMiddleware)
  .post(
    "/:orgSlug/projects/:projectId/android/setup",
    describeRoute({
      description: "Create the immutable Android app identity and request its per-app key.",
      responses: {
        200: {
          description: "Android setup state",
          content: { "application/json": { schema: resolver(androidAppSchemaResponse) } },
        },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "Project not found", ...errorResponse },
      },
    }),
    validator("param", androidAppSchemaParam),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const project = await fetchProject(db).getInOrganization(c.var.organization.id, projectId, [
        "id",
      ])
      if (project === undefined) return throwNotFound(c, "Project not found")
      await ensureAndroidSetup(db, project.id)
      return c.json((await status(c.var.organization.id, project.id))!)
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/android/status",
    describeRoute({
      description: "Read key, registration, setup-commit, release, and signer-job state.",
      responses: {
        200: {
          description: "Android setup state",
          content: { "application/json": { schema: resolver(androidAppSchemaResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "Android setup not found", ...errorResponse },
      },
    }),
    validator("param", androidAppSchemaParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const result = await status(c.var.organization.id, c.req.valid("param").projectId)
      return result === undefined ? throwNotFound(c, "Android setup not found") : c.json(result)
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/android/verify",
    describeRoute({
      description:
        "Verify that the setup commit is the connected repository's production-branch HEAD.",
      responses: {
        200: {
          description: "Verified Android setup state",
          content: { "application/json": { schema: resolver(androidAppSchemaResponse) } },
        },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "Project or Android setup not found", ...errorResponse },
        409: { description: "Commit is not production HEAD", ...errorResponse },
      },
    }),
    validator("param", androidAppSchemaParam),
    validator("json", androidAppSchemaVerifyRequest),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const project = await fetchProject(db).getInOrganization(c.var.organization.id, projectId, [
        "repositoryId",
        "productionBranch",
      ])
      if (project === undefined) return throwNotFound(c, "Project not found")
      const android = await fetchAndroidApp(db).getForProject(projectId, ["id"])
      if (android === undefined) return throwNotFound(c, "Android setup not found")
      const repository = await fetchRepository(db).getInOrganization(
        c.var.organization.id,
        project.repositoryId,
        ["ownerLogin", "name", "defaultBranch", "githubRepoId"],
      )
      if (repository === undefined) return throwNotFound(c, "Repository not found")
      const repositoryId = Number(repository.githubRepoId)
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
        return throwNotFound(c, "GitHub repository not found")
      }
      const credential = await organizationGitHubCredential(
        db,
        c.var.organization.id,
        { purpose: "project-repository-read", repositoryId },
        repository.ownerLogin,
      )
      if (credential === undefined) return throwNotFound(c, "GitHub installation not found")
      const branch = project.productionBranch ?? repository.defaultBranch
      const head = await createGitHubClient().request<{ object: { sha: string } }>({
        method: "GET",
        path: `/repos/${repository.ownerLogin}/${repository.name}/git/ref/heads/${encodeURIComponent(branch)}`,
        credential,
      })
      const commit = c.req.valid("json").commit
      if (head.data.object.sha !== commit) {
        return throwConflict(c, `Commit ${commit} is not ${branch} HEAD`)
      }
      await recordVerifiedSetupCommit(db, android.id, commit)
      return c.json((await status(c.var.organization.id, projectId))!)
    },
  )

export default app
