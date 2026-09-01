import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { post } from "@lib/billing"
import { db } from "@sproutos/db"
import { encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"
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
import { driverFor } from "./services"

type Json = Record<string, unknown>

const FASTAPI_FIXTURE = new URL("./fixtures/oauth-fastapi/", import.meta.url)
const redirectUri = "http://127.0.0.1:8787/oauth/callback"
const verifier = `oauth-acceptance-${v7()}-${v7()}`
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
let repositoryId = ""

async function oauthCall(accessToken: string, method: string, path: string, body?: unknown) {
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

async function authorize(scopes: string[], state: string): Promise<string> {
  const consent = await app.request("/v1/oauth/consent", {
    method: "POST",
    headers: authHeaders(owner!),
    body: JSON.stringify({
      clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: encodeBase64UrlNoPadding(await sha256Utf8(verifier)),
      codeChallengeMethod: "S256",
      organizationId,
    }),
  })
  expect(consent.status).toBe(200)
  const redirectTo = new URL(String(((await consent.json()) as Json).redirectTo))
  expect(redirectTo.origin + redirectTo.pathname).toBe(redirectUri)
  expect(redirectTo.searchParams.get("state")).toBe(state)
  const code = redirectTo.searchParams.get("code")
  expect(code).not.toBeNull()

  const exchange = await app.request("/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  const exchanged = (await exchange.json()) as Json
  expect({ status: exchange.status, body: exchanged }).toMatchObject({ status: 200 })
  const exchangedScopes = String(exchanged.scope).split(" ")
  expect(exchangedScopes).toHaveLength(scopes.length)
  expect(new Set(exchangedScopes)).toEqual(new Set(scopes))
  return String(exchanged.access_token)
}

async function runFastApi(connectionUri: string): Promise<void> {
  const port = 18_000 + Math.floor(Math.random() * 1_000)
  const child = spawn(
    "uv",
    [
      "run",
      "--with-requirements",
      "requirements.txt",
      "uvicorn",
      "main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: fileURLToPath(FASTAPI_FIXTURE),
      env: { ...process.env, DATABASE_URL: connectionUri },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let output = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => (output += chunk))
  child.stderr.on("data", (chunk: string) => (output += chunk))

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(`${message}:\n${output}`))
      }
      const timeout = setTimeout(() => {
        fail("FastAPI did not start")
      }, 30_000)
      const ready = (chunk: string) => {
        if (settled || !chunk.includes("Application startup complete")) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      child.stdout.on("data", ready)
      child.stderr.on("data", ready)
      child.once("error", (error) => {
        fail(`FastAPI could not launch (${String(error)})`)
      })
      child.once("exit", (code) => {
        fail(`FastAPI exited ${String(code)} before startup`)
      })
      if (child.exitCode !== null) fail(`FastAPI exited ${String(child.exitCode)} before startup`)
    })

    const first = await fetch(`http://127.0.0.1:${port}/visits`)
    const second = await fetch(`http://127.0.0.1:${port}/visits`)
    const firstBody: unknown = await first.json()
    const secondBody: unknown = await second.json()
    expect({ status: first.status, body: firstBody }).toEqual({
      status: 200,
      body: { visits: 1 },
    })
    expect({ status: second.status, body: secondBody }).toEqual({
      status: 200,
      body: { visits: 2 },
    })
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) =>
        child.once("exit", () => {
          resolve()
        }),
      )
    }
  }
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
    .insertInto("oauthClientRedirectUri")
    .values({
      id: v7(),
      oauthClientId: clientId,
      uri: redirectUri,
    })
    .execute()
  await db
    .insertInto("account")
    .values({
      id: v7(),
      userId: owner.id,
      type: "oauth",
      provider: "google",
      providerAccountId: `google-only-${owner.id}`,
      scopes: ["openid", "email", "profile"],
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: String(Date.now()),
      ownerLogin: "MySproutOS",
      name: `oauth-fastapi-${repositoryId.slice(-8)}`,
      defaultBranch: "main",
      private: false,
      isFork: false,
      provenance: "imported",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !valkeyReachable || !kmsUp) return

  // A failed assertion after provider provisioning must not leave a real tenant database behind.
  // The generic fixture cleanup only owns control-plane rows; destroy provider resources first.
  const leftovers = await db
    .selectFrom("backendService")
    .select(["id", "kind"])
    .where("organizationId", "=", organizationId)
    .execute()
  await Promise.all(leftovers.map(async (service) => driverFor(service.kind).destroy(service.id)))
  if (leftovers.length > 0) {
    await db
      .deleteFrom("backendService")
      .where(
        "id",
        "in",
        leftovers.map((service) => service.id),
      )
      .execute()
  }
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
    expect(main).toContain('handler = Mangum(app, lifespan="auto")')
    expect(dockerfile).toContain('"uvicorn", "main:app"')
    expect(requirements).toContain("asyncpg==")
  })

  it.skipIf(!reachable || !valkeyReachable || !kmsUp)(
    "proves Google-only consent, credit enforcement, and a database-backed FastAPI app",
    async () => {
      const linkedAccounts = await db
        .selectFrom("account")
        .select("provider")
        .where("userId", "=", owner!.id)
        .execute()
      expect(linkedAccounts.map((account) => account.provider)).toEqual(["google"])

      const databases = await app.request(`/v1/orgs/${orgSlug}/services`, {
        headers: authHeaders(owner!),
      })
      expect(databases.status).toBe(200)

      const githubOwners = await app.request(`/v1/orgs/${orgSlug}/github/owners`, {
        headers: authHeaders(owner!),
      })
      expect(githubOwners.status).toBe(200)
      expect((await githubOwners.json()) as object).toMatchObject({ data: [] })

      const baseScopes = ["project:create", "project:read"]
      const skippedToken = await authorize(baseScopes, "skip-database")
      const skippedDatabase = await oauthCall(
        skippedToken,
        "POST",
        `/v1/orgs/${orgSlug}/services`,
        { name: "must not exist", kind: "postgres" },
      )
      expect(skippedDatabase.status).toBe(403)

      const grantedScopes = [
        ...baseScopes,
        "project:update",
        "database:create",
        "database:read",
        "database:delete",
      ]
      const accessToken = await authorize(grantedScopes, "grant-database")
      const noCredit = await oauthCall(accessToken, "POST", `/v1/orgs/${orgSlug}/services`, {
        name: "still must not exist",
        kind: "postgres",
      })
      expect(noCredit.status).toBe(402)

      await post(db, {
        organizationId,
        kind: "promo",
        idempotencyKey: `test:oauth-fastapi:${organizationId}`,
        postings: [
          { account: "promotional", amount: -1_000_000n },
          { account: "user_credit", amount: 1_000_000n },
        ],
      })

      const project = await oauthCall(accessToken, "POST", `/v1/orgs/${orgSlug}/projects`, {
        name: "FastAPI visits",
        kind: "site",
        region: "us-east-1",
        rootDir: ".",
        dockerfilePath: "Dockerfile",
        source: { type: "repository", repositoryId },
      })
      expect({ status: project.status, body: project.json }).toMatchObject({ status: 201 })
      const projectBody = project.json.project as Json
      const projectJob = project.json.job as Json
      const projectId = projectBody.id as string

      const service = await oauthCall(accessToken, "POST", `/v1/orgs/${orgSlug}/services`, {
        name: "FastAPI visits database",
        kind: "postgres",
        projectId,
      })
      expect({ status: service.status, body: service.json }).toMatchObject({ status: 201 })
      expect(String(service.json.connectionUri)).toMatch(/^postgres(?:ql)?:\/\//)

      try {
        await runFastApi(String(service.json.connectionUri))
      } catch (error) {
        await oauthCall(
          accessToken,
          "DELETE",
          `/v1/orgs/${orgSlug}/services/${service.json.id as string}`,
        )
        await db
          .deleteFrom("backendService")
          .where("id", "=", service.json.id as string)
          .execute()
        throw error
      }

      const projects = await oauthCall(accessToken, "GET", `/v1/orgs/${orgSlug}/projects`)
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

      const services = await oauthCall(accessToken, "GET", `/v1/orgs/${orgSlug}/services`)
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

      const personalized = await app.request(`/v1/orgs/${orgSlug}/projects/${projectId}`, {
        method: "PATCH",
        headers: authHeaders(owner!),
        body: JSON.stringify({
          name: "My personalized FastAPI visits",
          description: "Changed by the user after OAuth creation",
        }),
      })
      expect(personalized.status).toBe(200)
      expect((await personalized.json()) as object).toMatchObject({
        id: projectId,
        name: "My personalized FastAPI visits",
        description: "Changed by the user after OAuth creation",
        managedByOauthApp: { clientId, name: "FastAPI Database Builder" },
      })

      const deleted = await oauthCall(
        accessToken,
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
    90_000,
  )
})
