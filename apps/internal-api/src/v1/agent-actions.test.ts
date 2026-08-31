import { mintProxyToken } from "@lib/agent"
import { crudAgentSession, fetchAgentSession } from "@lib/dao"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()

type Json = Record<string, unknown>

async function jsonRequest(
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

async function createOrganization(user: TestUser, name: string) {
  const response = await app.request("/v1/orgs", {
    method: "POST",
    headers: { Cookie: `session=${user.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return (await response.json()) as { id: string; slug: string }
}

describe.skipIf(!reachable)("agent group-primary action", () => {
  let owner: TestUser
  let unprivileged: TestUser
  let orgAId = ""
  let orgASlug = ""
  let orgBId = ""
  let orgBSlug = ""
  let groupId = ""
  let otherGroupId = ""
  let webId = ""
  let apiId = ""
  let outsiderId = ""
  let standaloneId = ""
  let crossOrgGroupId = ""

  async function turnToken(scopeProjectId: string, actorUserId = owner.id) {
    const session = await crudAgentSession(db).createSession({
      projectId: scopeProjectId,
      createdByUserId: actorUserId,
    })
    const turn = await crudAgentSession(db).openTurn({
      agentSessionId: session.id,
      role: "user",
      inputText: "Make the web app the customer-facing project",
    })
    const token = await mintProxyToken(db, {
      actorUserId,
      agentCredentialId: null,
      agentSessionId: session.id,
      agentTurnId: turn.id,
      organizationId: orgAId,
      projectId: scopeProjectId,
    })
    return { ...token, sessionId: session.id, turnId: turn.id }
  }

  beforeAll(async () => {
    owner = await createTestUser("agent-primary-owner")
    unprivileged = await createTestUser("agent-primary-member")

    const orgA = await createOrganization(owner, "Agent Primary A")
    const orgB = await createOrganization(owner, "Agent Primary B")
    orgAId = trackOrganization(orgA.id)
    orgASlug = orgA.slug
    orgBId = trackOrganization(orgB.id)
    orgBSlug = orgB.slug

    await db
      .insertInto("organizationMember")
      .values({
        id: v7(),
        organizationId: orgAId,
        userId: unprivileged.id,
        status: "active",
      })
      .execute()

    const repositoryA = v7()
    const repositoryB = v7()
    await db
      .insertInto("repository")
      .values([
        {
          id: repositoryA,
          organizationId: orgAId,
          githubRepoId: BigInt("771001"),
          ownerLogin: "sprout-test",
          name: "agent-primary-a",
          provenance: "fork",
          isFork: true,
          upstreamFullName: "TestSproutOS/upstream-action-test",
          upstreamDefaultBranch: "main",
        },
        {
          id: repositoryB,
          organizationId: orgBId,
          githubRepoId: BigInt("771002"),
          ownerLogin: "sprout-test",
          name: "agent-primary-b",
          provenance: "new",
        },
      ])
      .execute()

    groupId = v7()
    otherGroupId = v7()
    webId = v7()
    apiId = v7()
    outsiderId = v7()
    standaloneId = v7()
    crossOrgGroupId = v7()
    await db
      .insertInto("project")
      .values([
        {
          id: groupId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Product Suite",
          slug: `product-suite-${groupId.slice(-6)}`,
          isGroup: true,
          state: "ready",
        },
        {
          id: otherGroupId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Other Suite",
          slug: `other-suite-${otherGroupId.slice(-6)}`,
          isGroup: true,
          state: "ready",
        },
        {
          id: webId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Product Web",
          slug: `product-web-${webId.slice(-6)}`,
          rootDir: "apps/web",
          parentProjectId: groupId,
          state: "ready",
        },
        {
          id: apiId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Product API",
          slug: `product-api-${apiId.slice(-6)}`,
          rootDir: "apps/api",
          parentProjectId: groupId,
          state: "ready",
        },
        {
          id: outsiderId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Other Web",
          slug: `other-web-${outsiderId.slice(-6)}`,
          rootDir: "apps/other",
          parentProjectId: otherGroupId,
          state: "ready",
        },
        {
          id: standaloneId,
          organizationId: orgAId,
          repositoryId: repositoryA,
          name: "Standalone",
          slug: `standalone-${standaloneId.slice(-6)}`,
          rootDir: "apps/standalone",
          state: "ready",
        },
        {
          id: crossOrgGroupId,
          organizationId: orgBId,
          repositoryId: repositoryB,
          name: "Another Organization",
          slug: `cross-org-${crossOrgGroupId.slice(-6)}`,
          isGroup: true,
          state: "ready",
        },
      ])
      .execute()

    const deploymentId = v7()
    await db
      .insertInto("deployment")
      .values({
        id: deploymentId,
        projectId: webId,
        kind: "production",
        gitSha: "a".repeat(40),
        status: "ready",
        hostname: "generated.sproutos.run",
        url: "https://generated.sproutos.run",
      })
      .execute()
    await db
      .updateTable("project")
      .set({ liveDeploymentId: deploymentId })
      .where("id", "=", webId)
      .execute()
    await db
      .insertInto("customDomain")
      .values({
        id: v7(),
        organizationId: orgAId,
        projectId: webId,
        hostname: "product.example.test",
        verificationToken: "agent-primary-test",
        // Still serves while renewal is retried, so it must remain the customer-facing hostname.
        status: "renewal_warning",
      })
      .execute()
  })

  afterAll(async () => {
    await cleanupFixtures()
  })

  it("sets a direct child, returns its label/domain, and persists audit plus chat activity", async () => {
    const token = await turnToken(groupId)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )

    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({
      action: "set_group_primary_project",
      groupName: "Product Suite",
      primaryProjectName: "Product Web",
      primaryHostname: "product.example.test",
      primaryUrl: "https://product.example.test",
    })

    const [group, audit, events] = await Promise.all([
      db
        .selectFrom("project")
        .select("primaryChildProjectId")
        .where("id", "=", groupId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("auditLog")
        .select(["actorUserId", "before", "after"])
        .where("resourceSrn", "=", `srn:sproutos:project:${orgAId}:project/${groupId}`)
        .where("action", "=", "project:update")
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
      fetchAgentSession(db).listEvents(token.sessionId, null),
    ])
    expect(group.primaryChildProjectId).toBe(webId)
    expect(audit.actorUserId).toBe(owner.id)
    expect(audit.after).toMatchObject({
      agentTurnId: token.turnId,
      primaryChildProjectId: webId,
      primaryProjectName: "Product Web",
      source: "agent",
    })
    const platformEvent = events.find(
      (event) => event.agentTurnId === token.turnId && event.type === "platform_action",
    )
    expect(platformEvent).toBeDefined()
    expect(platformEvent?.payload as { primaryHostname: string }).toMatchObject({
      primaryHostname: "product.example.test",
    })
  })

  it("queues the trusted PR-gated upstream flow for the scoped project", async () => {
    const token = await turnToken(webId)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${webId}/agent/actions/update-upstream`,
      token.accessToken,
      {},
    )
    expect(response.status).toBe(202)
    expect(response.json).toMatchObject({
      action: "update_from_upstream",
      upstreamFullName: "TestSproutOS/upstream-action-test",
    })
    const queued = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload"])
      .where("id", "=", response.json.jobId as string)
      .executeTakeFirstOrThrow()
    expect(queued.kind).toBe("upkeep.repository")
    expect(queued.payload).toMatchObject({
      requestedProjectId: webId,
      requestedByUserId: owner.id,
    })
  })

  it("rejects a project associated with a different group", async () => {
    const token = await turnToken(groupId)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `other-web-${outsiderId.slice(-6)}` },
    )
    expect(response.status).toBe(400)
  })

  it("does not report a soft-deleted live deployment as the selected destination", async () => {
    await Promise.all([
      db
        .updateTable("customDomain")
        .set({ deletedAt: new Date() })
        .where("projectId", "=", webId)
        .execute(),
      db
        .updateTable("deployment")
        .set({ deletedAt: new Date() })
        .where("projectId", "=", webId)
        .execute(),
    ])

    const token = await turnToken(groupId)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )
    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({ primaryHostname: null, primaryUrl: null })

    await Promise.all([
      db
        .updateTable("customDomain")
        .set({ deletedAt: null })
        .where("projectId", "=", webId)
        .execute(),
      db
        .updateTable("deployment")
        .set({ deletedAt: null })
        .where("projectId", "=", webId)
        .execute(),
    ])
  })

  it("lets a child-scoped turn nominate itself but not a sibling", async () => {
    const token = await turnToken(apiId)
    const accepted = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${apiId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-api-${apiId.slice(-6)}` },
    )
    expect(accepted.status).toBe(200)
    expect(accepted.json).toMatchObject({
      groupName: "Product Suite",
      primaryProjectName: "Product API",
      primaryHostname: null,
    })

    const sibling = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${apiId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )
    expect(sibling.status).toBe(400)
  })

  it("rejects a cross-organization path without revealing its scope", async () => {
    const token = await turnToken(groupId)
    const response = await jsonRequest(
      `/v1/orgs/${orgBSlug}/projects/${crossOrgGroupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )
    expect(response.status).toBe(404)
  })

  it("rejects a standalone project", async () => {
    const token = await turnToken(standaloneId)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${standaloneId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `standalone-${standaloneId.slice(-6)}` },
    )
    expect(response.status).toBe(400)
  })

  it("re-evaluates the initiating user's live project:update permission", async () => {
    const token = await turnToken(groupId, unprivileged.id)
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-api-${apiId.slice(-6)}` },
    )
    expect(response.status).toBe(403)
  })

  it("does not treat a manually minted model-proxy token as an agent action token", async () => {
    const token = await mintProxyToken(db, {
      agentCredentialId: null,
      organizationId: orgAId,
      projectId: groupId,
    })
    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-api-${apiId.slice(-6)}` },
    )
    expect(response.status).toBe(401)
  })

  it("stops accepting a revoked turn token immediately", async () => {
    const token = await turnToken(groupId)
    await db
      .updateTable("agentProxyToken")
      .set({ revokedAt: new Date() })
      .where("id", "=", token.id)
      .execute()

    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )
    expect(response.status).toBe(401)
  })

  it("stops accepting a token once its turn has finished", async () => {
    const token = await turnToken(groupId)
    await crudAgentSession(db).closeTurn(token.turnId, { resultSubtype: "success" })

    const response = await jsonRequest(
      `/v1/orgs/${orgASlug}/projects/${groupId}/agent/actions/group-primary`,
      token.accessToken,
      { primaryProjectSlug: `product-web-${webId.slice(-6)}` },
    )
    expect(response.status).toBe(401)
  })
})
