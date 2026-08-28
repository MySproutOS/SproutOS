import { readFile } from "node:fs/promises"
import { post } from "@lib/billing"
import { hashToken } from "@lib/oauth-provider"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  kmsReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

type Json = Record<string, unknown>

const FASTAPI_FIXTURE = new URL("./fixtures/oauth-fastapi/", import.meta.url)
const accessToken = `oauth_acceptance_${v7()}`
const reachable = await databaseReachable()
const kmsUp = await (async () => {
  if (await kmsReachable()) return true

  // CI bootstraps this LocalStack alias but deliberately does not export KMS_KEY_ID. Adopt the
  // known development alias only for a loopback endpoint; never turn a missing production key
  // into an SDK call against an assumed AWS key.
  const endpoint = process.env.AWS_ENDPOINT_URL
  if (endpoint === undefined || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname)) {
    return false
  }
  process.env.KMS_KEY_ID = "alias/sproutos-dev"
  return kmsReachable()
})()
const valkeyReachable = await (async () => {
  const client = new Redis(process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://localhost:41023", {
    connectTimeout: 500,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  })
  try {
    await client.connect()
    return (await client.ping()) === "PONG"
  } catch {
    return false
  } finally {
    client.disconnect()
  }
})()

let owner: TestUser | undefined
let organizationId = ""
let orgSlug = ""
let clientId = ""
let grantId = ""
let repositoryId = ""

async function oauthCall(method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

beforeAll(async () => {
  if (!reachable || !valkeyReachable || !kmsUp) return
  owner = await createTestUser("oauth-fastapi")
  const organizationResponse = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(owner),
    body: JSON.stringify({ name: `OAuth FastAPI ${v7()}` }),
  })
  const organization = (await organizationResponse.json()) as Json
  organizationId = trackOrganization(organization.id as string)
  orgSlug = organization.slug as string

  clientId = v7()
  grantId = v7()
  repositoryId = v7()
  const scopes = [
    "project:create",
    "project:read",
    "database:create",
    "database:read",
    "database:delete",
  ]

  await db
    .insertInto("oauthClient")
    .values({
      id: clientId,
      ownerUserId: owner.id,
      organizationId,
      name: "FastAPI Database Builder",
      homepageUrl: "https://fastapi.example.test",
      clientType: "public",
      defaultScopes: scopes,
      isFirstParty: false,
    })
    .execute()
  await db
    .insertInto("oauthGrant")
    .values({
      id: grantId,
      oauthClientId: clientId,
      userId: owner.id,
      organizationId,
      scopes,
    })
    .execute()
  await db
    .insertInto("oauthAccessToken")
    .values({
      tokenHash: await hashToken(accessToken),
      oauthGrantId: grantId,
      oauthClientId: clientId,
      userId: owner.id,
      scopes,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: String(Date.now()),
      ownerLogin: "SproutOS-Apps",
      name: `oauth-fastapi-${repositoryId.slice(-8)}`,
      defaultBranch: "main",
      private: false,
      isFork: false,
      provenance: "imported",
    })
    .execute()

  await post(db, {
    organizationId,
    kind: "promo",
    idempotencyKey: `test:oauth-fastapi:${organizationId}`,
    postings: [
      { account: "promotional", amount: -1_000_000n },
      { account: "user_credit", amount: 1_000_000n },
    ],
  })
})

afterAll(async () => {
  if (!reachable || !valkeyReachable || !kmsUp) return
  await cleanupFixtures()
  await db.destroy()
})

describe("OAuth FastAPI and database acceptance", () => {
  it("keeps a runnable database-backed FastAPI fixture", async () => {
    const [main, dockerfile, requirements] = await Promise.all([
      readFile(new URL("main.py", FASTAPI_FIXTURE), "utf8"),
      readFile(new URL("Dockerfile", FASTAPI_FIXTURE), "utf8"),
      readFile(new URL("requirements.txt", FASTAPI_FIXTURE), "utf8"),
    ])
    expect(main).toContain('os.environ["DATABASE_URL"]')
    expect(main).toContain("create table if not exists visit_counter")
    expect(main).toContain('@app.get("/visits")')
    expect(dockerfile).toContain('"uvicorn", "main:app"')
    expect(requirements).toContain("asyncpg==")
  })

  it.skipIf(!reachable || !valkeyReachable || !kmsUp)(
    "lets one OAuth grant create the API project, its group, and its database",
    async () => {
      const project = await oauthCall("POST", `/v1/orgs/${orgSlug}/projects`, {
        name: "FastAPI visits",
        kind: "site",
        rootDir: ".",
        dockerfilePath: "Dockerfile",
        source: { type: "repository", repositoryId },
      })
      expect({ status: project.status, body: project.json }).toMatchObject({ status: 201 })
      const projectBody = project.json.project as Json
      const projectJob = project.json.job as Json
      const projectId = projectBody.id as string

      const service = await oauthCall("POST", `/v1/orgs/${orgSlug}/services`, {
        name: "FastAPI visits database",
        kind: "postgres",
        projectId,
      })
      expect({ status: service.status, body: service.json }).toMatchObject({ status: 201 })
      expect(String(service.json.connectionUri)).toMatch(/^postgres(?:ql)?:\/\//)

      const projects = await oauthCall("GET", `/v1/orgs/${orgSlug}/projects`)
      const projectRows = projects.json.data as Json[]
      const createdProject = projectRows.find((row) => row.id === projectId)
      const createdGroup = projectRows.find((row) => row.isGroup === true)
      expect(createdProject?.managedByOauthApp).toEqual({
        clientId,
        name: "FastAPI Database Builder",
      })
      expect(createdGroup?.managedByOauthApp).toEqual({
        clientId,
        name: "FastAPI Database Builder",
      })

      const services = await oauthCall("GET", `/v1/orgs/${orgSlug}/services`)
      expect((services.json.data as Json[])[0]?.managedByOauthApp).toEqual({
        clientId,
        name: "FastAPI Database Builder",
      })

      const queued = await db
        .selectFrom("backgroundJob")
        .select("id")
        .where("idempotencyKey", "=", `project.provision:${projectJob.id as string}`)
        .executeTakeFirst()
      expect(queued, "the deployment request must be queued").toBeDefined()

      const deleted = await oauthCall(
        "DELETE",
        `/v1/orgs/${orgSlug}/services/${service.json.id as string}`,
      )
      expect(deleted.status).toBe(200)

      // The product deliberately keeps the soft-deleted service and database rows for billing
      // history. This fixture organization has no history to retain, and cleanupFixtures hard-deletes
      // it, so remove the retained root after the driver has already destroyed the real database.
      await db
        .deleteFrom("backendService")
        .where("id", "=", service.json.id as string)
        .execute()
    },
  )
})
