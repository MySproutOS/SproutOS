import {
  createAuthorizationCode,
  SPROUT_CLI_CLIENT_ID,
  SPROUT_CLI_REDIRECT_URI,
} from "@lib/oauth-provider"
import { db } from "@sproutos/db"
import { encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import { readDeployToken } from "./deploy"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()
const verifier = "v".repeat(43)
const redirectUri = "http://127.0.0.1:49152/oauth/callback"
const previousDeployTokenSecret = process.env.DEPLOY_TOKEN_SECRET
let user: TestUser | undefined
let organizationId = ""
let organizationSlug = ""
let grantId = ""
let projectId = ""
let projectSlug = ""

async function code(scopes = ["project:read", "deployment:write"]): Promise<string> {
  return await createAuthorizationCode(db, {
    oauthClientId: SPROUT_CLI_CLIENT_ID,
    userId: user!.id,
    organizationId,
    oauthGrantId: grantId,
    redirectUri,
    scopes,
    codeChallenge: encodeBase64UrlNoPadding(await sha256Utf8(verifier)),
  })
}

async function exchange(authorizationCode: string): Promise<Response> {
  return await app.request("/v1/auth/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: authorizationCode,
      clientId: SPROUT_CLI_CLIENT_ID,
      redirectUri,
      codeVerifier: verifier,
    }),
  })
}

beforeAll(async () => {
  if (!reachable) return
  process.env.DEPLOY_TOKEN_SECRET = "cli-auth-test-secret"
  user = await createTestUser("cli-auth")
  const organizationResponse = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: `CLI auth ${v7()}` }),
  })
  const organization = (await organizationResponse.json()) as { id: string; slug: string }
  organizationId = trackOrganization(organization.id)
  organizationSlug = organization.slug
  const repositoryId = v7()
  projectId = v7()
  projectSlug = `cli-deploy-${projectId.slice(-8)}`
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: String(Date.now()),
      ownerLogin: "cli-auth-test",
      name: `deploy-${projectId}`,
      defaultBranch: "main",
      private: true,
      isFork: false,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "CLI deploy target",
      slug: projectSlug,
      kind: "site",
    })
    .execute()

  await db
    .insertInto("oauthClient")
    .values({
      id: SPROUT_CLI_CLIENT_ID,
      name: "Sprout CLI",
      homepageUrl: "https://sproutos.me/download",
      clientType: "public",
      isFirstParty: true,
      isVerified: true,
      defaultScopes: ["*"],
    })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute()

  const registered = await db
    .selectFrom("oauthClientRedirectUri")
    .select("id")
    .where("oauthClientId", "=", SPROUT_CLI_CLIENT_ID)
    .where("uri", "=", SPROUT_CLI_REDIRECT_URI)
    .executeTakeFirst()
  if (registered === undefined) {
    await db
      .insertInto("oauthClientRedirectUri")
      .values({ id: v7(), oauthClientId: SPROUT_CLI_CLIENT_ID, uri: SPROUT_CLI_REDIRECT_URI })
      .execute()
  }

  grantId = v7()
  await db
    .insertInto("oauthGrant")
    .values({
      id: grantId,
      oauthClientId: SPROUT_CLI_CLIENT_ID,
      userId: user.id,
      organizationId,
      scopes: ["project:read", "deployment:write"],
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await cleanupFixtures()
  await db.destroy()
  if (previousDeployTokenSecret === undefined) delete process.env.DEPLOY_TOKEN_SECRET
  else process.env.DEPLOY_TOKEN_SECRET = previousDeployTokenSecret
})

describe.skipIf(!reachable)("Sprout CLI PKCE exchange", () => {
  it("issues one grant-linked organization key and burns the code", async () => {
    const authorizationCode = await code()
    const response = await exchange(authorizationCode)
    expect(response.status).toBe(201)
    const result = (await response.json()) as {
      key: string
      scopes: string[]
      expiresAt: string | null
      organization: { id: string; slug: string }
    }

    expect(result.organization).toEqual({ id: organizationId, slug: organizationSlug })
    expect(result.scopes).toEqual(["project:read", "deployment:write"])
    expect(result.expiresAt).toBeNull()

    const stored = await db
      .selectFrom("apiKey")
      .select(["organizationId", "oauthGrantId"])
      .where("keyHash", "is not", null)
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow()
    expect(stored).toEqual({ organizationId, oauthGrantId: grantId })

    const status = await app.request("/v1/auth/me", {
      headers: { Authorization: `Bearer ${result.key}` },
    })
    expect(status.status).toBe(200)
    expect((await status.json()) as object).toMatchObject({
      organization: { id: organizationId, slug: organizationSlug },
      authentication: { kind: "api_key", scopes: ["project:read", "deployment:write"] },
    })

    const deploy = await app.request(
      `/v1/orgs/${organizationSlug}/projects/${projectSlug}/deploy-token`,
      { method: "POST", headers: { Authorization: `Bearer ${result.key}` } },
    )
    expect(deploy.status).toBe(200)
    const deploymentCredential = (await deploy.json()) as { token: string }
    expect(readDeployToken(deploymentCredential.token, "cli-auth-test-secret")).toEqual({
      projectId,
      actorUserId: user!.id,
    })

    expect((await exchange(authorizationCode)).status).toBe(400)

    await db
      .updateTable("oauthGrant")
      .set({ revokedAt: new Date() })
      .where("id", "=", grantId)
      .execute()
    expect(
      (
        await app.request("/v1/auth/me", {
          headers: { Authorization: `Bearer ${result.key}` },
        })
      ).status,
    ).toBe(401)
  })

  it("lets a CLI revoke its current key without credential administration scope", async () => {
    await db
      .updateTable("oauthGrant")
      .set({ revokedAt: new Date() })
      .where("oauthClientId", "=", SPROUT_CLI_CLIENT_ID)
      .where("userId", "=", user!.id)
      .where("organizationId", "=", organizationId)
      .where("revokedAt", "is", null)
      .execute()
    grantId = v7()
    await db
      .insertInto("oauthGrant")
      .values({
        id: grantId,
        oauthClientId: SPROUT_CLI_CLIENT_ID,
        userId: user!.id,
        organizationId,
        scopes: ["project:read", "deployment:write"],
      })
      .execute()
    const response = await exchange(await code())
    const { key } = (await response.json()) as { key: string }

    const revoked = await app.request("/v1/auth/cli/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    })
    expect(revoked.status).toBe(200)
    expect(
      (await app.request("/v1/auth/me", { headers: { Authorization: `Bearer ${key}` } })).status,
    ).toBe(401)
  })

  it("refuses interactive deployment without deployment:write", async () => {
    await db
      .updateTable("oauthGrant")
      .set({ revokedAt: new Date() })
      .where("oauthClientId", "=", SPROUT_CLI_CLIENT_ID)
      .where("userId", "=", user!.id)
      .where("organizationId", "=", organizationId)
      .where("revokedAt", "is", null)
      .execute()
    grantId = v7()
    await db
      .insertInto("oauthGrant")
      .values({
        id: grantId,
        oauthClientId: SPROUT_CLI_CLIENT_ID,
        userId: user!.id,
        organizationId,
        scopes: ["project:read"],
      })
      .execute()
    const response = await exchange(await code(["project:read"]))
    const { key } = (await response.json()) as { key: string }

    const deploy = await app.request(
      `/v1/orgs/${organizationSlug}/projects/${projectId}/deploy-token`,
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
    )
    expect(deploy.status).toBe(403)
  })
})
