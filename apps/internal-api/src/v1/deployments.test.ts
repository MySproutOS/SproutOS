import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const reachable = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

const SHA = "a".repeat(40)

describe.skipIf(!reachable)("deployment routes", () => {
  let owner: TestUser
  let stranger: TestUser
  let slug: string
  let strangerSlug: string
  let projectId: string
  let strangerProjectId: string

  async function seedProject(user: TestUser, orgName: string) {
    const created = await call("POST", "/v1/orgs", user, { name: orgName })
    const organization = created.json as { id: string; slug: string }
    trackOrganization(organization.id)

    const repositoryId = v7()
    const id = v7()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId: organization.id,
        githubRepoId: BigInt(`0x${id.replaceAll("-", "").slice(-12)}`),
        ownerLogin: "acme",
        name: `repo-${id.slice(-8)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id,
        organizationId: organization.id,
        repositoryId,
        name: "App",
        slug: `app-${id.slice(-8)}`,
      })
      .execute()

    return { organization, projectId: id }
  }

  beforeAll(async () => {
    owner = await createTestUser("deploy-owner")
    stranger = await createTestUser("deploy-stranger")

    const mine = await seedProject(owner, "Deploy Suite")
    slug = mine.organization.slug
    projectId = mine.projectId

    const theirs = await seedProject(stranger, "Other Deploy Suite")
    strangerSlug = theirs.organization.slug
    strangerProjectId = theirs.projectId
  })

  afterAll(async () => {
    await cleanupFixtures()
    await db.destroy()
  })

  it("queues a production deployment and returns the row to poll", async () => {
    const created = await call(
      "POST",
      `/v1/orgs/${slug}/projects/${projectId}/deployments`,
      owner,
      {
        gitSha: SHA,
        gitRef: "refs/heads/main",
      },
    )

    // 202, not 201: a deploy is a build, a push and a revision coming up. The row is the status.
    expect(created.status).toBe(202)
    expect(created.json.status).toBe("queued")
    expect(created.json.kind).toBe("production")
    expect(created.json.url).toBeNull()
  })

  it("enqueues exactly one job per deployment", async () => {
    const created = await call(
      "POST",
      `/v1/orgs/${slug}/projects/${projectId}/deployments`,
      owner,
      {
        gitSha: "b".repeat(40),
      },
    )
    const id = created.json.id as string

    const jobs = await db
      .selectFrom("backgroundJob")
      .select("id")
      .where("kind", "=", "deploy.revision")
      .where("idempotencyKey", "=", `deploy.revision:${id}`)
      .execute()

    // The row exists and the work is queued. A route that created the row and forgot the job would
    // leave a deployment stuck at `queued` forever with nothing to notice it.
    expect(jobs).toHaveLength(1)
  })

  it("refuses a preview with no PR number", async () => {
    // `pr-null--myapp` would be a real hostname pointing at a real deployment. Rejected here rather
    // than discovered by the renderer, where the only symptom is a strange URL.
    const created = await call(
      "POST",
      `/v1/orgs/${slug}/projects/${projectId}/deployments`,
      owner,
      {
        gitSha: SHA,
        kind: "preview",
      },
    )

    expect(created.status).toBe(400)
  })

  it("accepts a preview with a PR number", async () => {
    const created = await call(
      "POST",
      `/v1/orgs/${slug}/projects/${projectId}/deployments`,
      owner,
      {
        gitSha: SHA,
        kind: "preview",
        prNumber: 42,
      },
    )

    expect(created.status).toBe(202)
    expect(created.json.prNumber).toBe(42)
  })

  it("will not deploy another organization's project", async () => {
    // The project id is real and the caller's organization is real. `requirePermission` authorizes
    // against an SRN built from the *resolved* organization plus this parameter, so the permission
    // check passes and only the lookup's tenancy predicate stands in the way.
    const created = await call(
      "POST",
      `/v1/orgs/${slug}/projects/${strangerProjectId}/deployments`,
      owner,
      { gitSha: SHA },
    )

    expect(created.status).toBe(404)
  })

  it("will not read another organization's deployment", async () => {
    const theirs = await call(
      "POST",
      `/v1/orgs/${strangerSlug}/projects/${strangerProjectId}/deployments`,
      stranger,
      { gitSha: SHA },
    )
    expect(theirs.status).toBe(202)

    const read = await call(
      "GET",
      `/v1/orgs/${slug}/deployments/${theirs.json.id as string}`,
      owner,
    )

    expect(read.status).toBe(404)
  })

  it("lists a project's deployments newest first", async () => {
    const list = await call("GET", `/v1/orgs/${slug}/projects/${projectId}/deployments`, owner)

    expect(list.status).toBe(200)
    const rows = list.json.data as { createdAt: string }[]
    expect(rows.length).toBeGreaterThan(1)

    const times = rows.map((row) => Date.parse(row.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})
