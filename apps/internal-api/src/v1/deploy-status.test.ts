import { crudDeployment } from "@lib/dao"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import { databaseReachable } from "../test/fixtures"
import { mintDeployToken } from "./deploy"

const reachable = await databaseReachable()
const secret = "deploy-status-test-secret"
const previousSecret = process.env.DEPLOY_TOKEN_SECRET

describe.skipIf(!reachable)("deploy-token deployment status", () => {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const otherProjectId = v7()
  let deploymentId: string
  let otherDeploymentId: string

  beforeAll(async () => {
    process.env.DEPLOY_TOKEN_SECRET = secret

    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.test` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        ownerUserId: userId,
        kind: "team",
        name: "Deploy status",
        slug: `deploy-status-${organizationId.slice(-12)}`,
      })
      .execute()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: BigInt(`0x${repositoryId.slice(-12)}`),
        ownerLogin: "sproutos-test",
        name: `deploy-status-${repositoryId.slice(-8)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values([
        {
          id: projectId,
          organizationId,
          repositoryId,
          name: "Deploy status",
          slug: `deploy-status-${projectId.slice(-8)}`,
        },
        {
          id: otherProjectId,
          organizationId,
          repositoryId,
          name: "Other deploy status",
          slug: `deploy-status-${otherProjectId.slice(-8)}`,
          rootDir: "apps/other",
        },
      ])
      .execute()

    const deployment = await crudDeployment(db).create({
      projectId,
      kind: "production",
      gitSha: "a".repeat(40),
      status: "error",
      failureReason: "The database migration failed",
      migrationStatus: "failed",
      migrationOutput: "ImportModuleError: Cannot find module 'migrate'",
    })
    deploymentId = deployment.id

    const other = await crudDeployment(db).create({
      projectId: otherProjectId,
      kind: "production",
      gitSha: "b".repeat(40),
      status: "ready",
    })
    otherDeploymentId = other.id
  })

  afterAll(async () => {
    await db.deleteFrom("deployment").where("id", "in", [deploymentId, otherDeploymentId]).execute()
    await db.deleteFrom("project").where("id", "in", [projectId, otherProjectId]).execute()
    await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
    if (previousSecret === undefined) delete process.env.DEPLOY_TOKEN_SECRET
    else process.env.DEPLOY_TOKEN_SECRET = previousSecret
    await db.destroy()
  })

  function tokenFor(id: string): string {
    return mintDeployToken(id, Math.floor(Date.now() / 1000) + 900, secret)
  }

  it("returns the terminal failure and the migrator's output", async () => {
    const response = await app.request(`/v1/deploy/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${tokenFor(projectId)}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deployment_id: deploymentId,
      status: "error",
      failure_reason: "The database migration failed",
      migration_status: "failed",
      migration_output: "ImportModuleError: Cannot find module 'migrate'",
      url: null,
    })
  })

  it("does not reveal another project's deployment", async () => {
    const response = await app.request(`/v1/deploy/deployments/${otherDeploymentId}`, {
      headers: { Authorization: `Bearer ${tokenFor(projectId)}` },
    })

    expect(response.status).toBe(404)
  })

  it("requires a deploy token", async () => {
    const response = await app.request(`/v1/deploy/deployments/${deploymentId}`)

    expect(response.status).toBe(401)
  })
})
