import { mintProxyToken } from "@lib/agent"
import { crudAgentSession, crudSandbox, crudSandboxDatabaseBranch } from "@lib/dao"
import type { NeonPostgresConfig } from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"
import { createAgentDatabaseBranchesApp } from "./agent-database-branches"

const reachable = await databaseReachable()

describe.skipIf(!reachable)("agent database branch actions", () => {
  let user: TestUser
  let organizationId = ""
  let organizationSlug = ""
  let projectId = ""
  let backendServiceId = ""
  let sandboxId = ""
  let defaultBranchId = ""
  let regionId = ""
  let token = ""
  let turnId = ""
  const createdInputs: {
    parentDatabaseBranchId?: string
    ownerSandboxId?: string
    expiresAt?: Date
  }[] = []

  const config = {
    neon: {
      apiKey: "unused",
      apiUrl: "https://neon.invalid",
      orgId: "unused",
      regionId: "aws-us-east-1",
    },
    publicHost: "pg.test",
    publicPort: 5432,
  } satisfies NeonPostgresConfig

  const app = new Hono().basePath("/v1")
  app.route(
    "/orgs",
    createAgentDatabaseBranchesApp({
      config: () => config,
      create: async (database, _config, input) => {
        createdInputs.push(input)
        const databaseBranchId = v7()
        const instance = await database
          .selectFrom("databaseInstance")
          .select("id")
          .where("backendServiceId", "=", input.backendServiceId)
          .executeTakeFirstOrThrow()
        const name = `sandbox-${input.label}`
        await database
          .insertInto("databaseBranch")
          .values({
            id: databaseBranchId,
            databaseInstanceId: instance.id,
            parentBranchId: input.parentDatabaseBranchId,
            providerBranchId: `provider-${databaseBranchId}`,
            name,
            kind: "dev",
            expiresAt: input.expiresAt,
          })
          .execute()
        await crudSandboxDatabaseBranch(database).create({
          sandboxId: input.ownerSandboxId,
          databaseBranchId,
        })
        return { databaseBranchId, name, uri: "postgres://branch-secret@pg.test/db" }
      },
      drop: async (database, _config, databaseBranchId) => {
        await database.deleteFrom("databaseBranch").where("id", "=", databaseBranchId).execute()
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    }),
  )

  beforeAll(async () => {
    user = await createTestUser("agent-database-branch")
    const organizationResponse = await app.request("/v1/orgs", {
      method: "POST",
      headers: { Cookie: `session=${user.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Database Branches" }),
    })
    // This isolated app mounts only the agent action. Create the organization through the root API.
    if (organizationResponse.status === 404) {
      const root = (await import("../index")).default
      const response = await root.request("/v1/orgs", {
        method: "POST",
        headers: { Cookie: `session=${user.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Agent Database Branches" }),
      })
      const organization = (await response.json()) as { id: string; slug: string }
      organizationId = trackOrganization(organization.id)
      organizationSlug = organization.slug
    }

    const repositoryId = v7()
    projectId = v7()
    backendServiceId = v7()
    const databaseInstanceId = v7()
    defaultBranchId = v7()
    sandboxId = v7()
    regionId = v7()
    const region = await db
      .insertInto("region")
      .values({ id: regionId, code: `test-${regionId.slice(-8)}`, displayName: "Test region" })
      .returning("id")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: BigInt(Date.now()),
        ownerLogin: "sprout-test",
        name: `agent-branches-${repositoryId.slice(-8)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Agent Branch Project",
        slug: `agent-branch-${projectId.slice(-8)}`,
        state: "ready",
      })
      .execute()
    await db
      .insertInto("backendService")
      .values({
        id: backendServiceId,
        organizationId,
        projectId,
        regionId: region.id,
        name: "postgres",
        kind: "postgres",
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseInstance")
      .values({
        id: databaseInstanceId,
        backendServiceId,
        projectId,
        provider: "neon",
        providerProjectId: `provider-${databaseInstanceId}`,
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseBranch")
      .values({
        id: defaultBranchId,
        databaseInstanceId,
        providerBranchId: `provider-${defaultBranchId}`,
        name: "sandbox-default",
        kind: "dev",
      })
      .execute()
    await crudSandbox(db).create({
      id: sandboxId,
      projectId,
      userId: user.id,
      databaseBranchId: defaultBranchId,
      externalId: `daytona-${sandboxId}`,
      state: "running",
    })
    await crudSandboxDatabaseBranch(db).create({ sandboxId, databaseBranchId: defaultBranchId })

    const session = await crudAgentSession(db).createSession({
      projectId,
      createdByUserId: user.id,
    })
    const turn = await crudAgentSession(db).openTurn({
      agentSessionId: session.id,
      role: "user",
      inputText: "Test two schema alternatives",
    })
    turnId = turn.id
    token = (
      await mintProxyToken(db, {
        actorUserId: user.id,
        agentCredentialId: null,
        agentSessionId: session.id,
        agentTurnId: turn.id,
        organizationId,
        projectId,
      })
    ).accessToken
  })

  afterAll(async () => {
    if (projectId !== "") {
      await db.deleteFrom("databaseInstance").where("projectId", "=", projectId).execute()
    }
    await cleanupFixtures()
    if (regionId !== "") await db.deleteFrom("region").where("id", "=", regionId).execute()
  })

  it("creates from the sandbox copy, returns a no-store URL, and deletes only an alternative", async () => {
    const path = `/v1/orgs/${organizationSlug}/projects/${projectId}/agent/actions/database-branches`
    const invalid = await app.request(path, {
      method: "POST",
      headers: { Authorization: "Bearer invalid", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "invalid" }),
    })
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get("www-authenticate")).toContain("invalid_token")

    const crossScope = await app.request(
      `/v1/orgs/${organizationSlug}/projects/${v7()}/agent/actions/database-branches`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "wrong-project" }),
      },
    )
    expect(crossScope.status).toBe(404)

    const created = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "schema-two" }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const body = (await created.json()) as {
      databaseBranchId: string
      databaseUrl: string
      expiresAt: string
      name: string
    }
    expect(body).toMatchObject({
      databaseUrl: "postgres://branch-secret@pg.test/db",
      expiresAt: "2026-08-29T12:00:00.000Z",
    })
    expect(createdInputs.at(-1)).toMatchObject({
      parentDatabaseBranchId: defaultBranchId,
      ownerSandboxId: sandboxId,
    })

    const refusedDefault = await app.request(`${path}/${defaultBranchId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(refusedDefault.status).toBe(404)

    const deleted = await app.request(`${path}/${body.databaseBranchId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(deleted.status).toBe(204)
    await expect(
      db
        .selectFrom("databaseBranch")
        .select("id")
        .where("id", "=", body.databaseBranchId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()

    const audits = await db
      .selectFrom("auditLog")
      .select("action")
      .where(
        "resourceSrn",
        "=",
        `srn:sproutos:db:${organizationId}:branch/${body.databaseBranchId}`,
      )
      .orderBy("createdAt", "asc")
      .execute()
    expect(audits.map((audit) => audit.action)).toEqual([
      "database:branch:create",
      "database:branch:delete",
    ])

    await crudAgentSession(db).closeTurn(turnId, { resultSubtype: "success" })
    const afterTurn = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "too-late" }),
    })
    expect(afterTurn.status).toBe(401)
  })
})
