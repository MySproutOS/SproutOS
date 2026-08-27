import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  trackOrganization,
} from "../test/fixtures"

const oidc = vi.hoisted(() => ({ repository: "" }))

vi.mock("@lib/oauth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    verifyGitHubOidcToken: () => Promise.resolve({ repository: oidc.repository }),
  }
})

const { default: app } = await import("../index")
const { readDeployToken } = await import("./deploy")

const reachable = await databaseReachable()
const TOKEN_SECRET = "four-child-deploy-matrix-secret"
const DIGEST = "a".repeat(64)

type Json = Record<string, unknown>

async function post(
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

describe.skipIf(!reachable)("deploy-token project selection", () => {
  const priorSecret = process.env.DEPLOY_TOKEN_SECRET
  const children: { id: string; slug: string }[] = []
  let group = { id: "", slug: "" }

  beforeAll(async () => {
    process.env.DEPLOY_TOKEN_SECRET = TOKEN_SECRET

    const owner = await createTestUser("deploy-matrix")
    const organizationResponse = await app.request("/v1/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `session=${owner.sessionToken}`,
      },
      body: JSON.stringify({ name: "Deploy Matrix" }),
    })
    if (organizationResponse.status !== 201) {
      throw new Error(`fixture setup failed with HTTP ${organizationResponse.status}`)
    }
    const organization = (await organizationResponse.json()) as { id: string }
    trackOrganization(organization.id)

    const repositoryId = v7()
    const repositoryName = `four-child-${repositoryId.slice(-8)}`
    oidc.repository = `launch-matrix/${repositoryName}`
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId: organization.id,
        githubRepoId: BigInt(`0x${repositoryId.replaceAll("-", "").slice(-12)}`),
        ownerLogin: "launch-matrix",
        name: repositoryName,
        provenance: "new",
      })
      .execute()

    group = { id: v7(), slug: `group-${repositoryId.slice(-8)}` }
    await db
      .insertInto("project")
      .values({
        id: group.id,
        organizationId: organization.id,
        repositoryId,
        name: "Four-child group",
        slug: group.slug,
        isGroup: true,
      })
      .execute()

    for (const [index, name] of ["web", "api", "admin", "worker"].entries()) {
      const child = { id: v7(), slug: `${name}-${repositoryId.slice(-8)}` }
      children.push(child)
      // eslint-disable-next-line no-await-in-loop -- four related fixtures, ordered for diagnostics.
      await db
        .insertInto("project")
        .values({
          id: child.id,
          organizationId: organization.id,
          repositoryId,
          parentProjectId: group.id,
          name,
          slug: child.slug,
          rootDir: `apps/${index}-${name}`,
        })
        .execute()
    }
  })

  afterAll(async () => {
    if (priorSecret === undefined) delete process.env.DEPLOY_TOKEN_SECRET
    else process.env.DEPLOY_TOKEN_SECRET = priorSecret
    await cleanupFixtures()
    await db.destroy()
  })

  it("lands each of four named releases on the named child", async () => {
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop -- the matrix must attribute each release in turn.
      const exchanged = await post("/v1/deploy/token", {
        oidc_token: "verified-by-the-test-boundary",
        project: child.slug,
      })
      if (exchanged.status !== 200) {
        throw new Error(`token exchange failed: ${JSON.stringify(exchanged.json)}`)
      }

      const token = exchanged.json.token as string
      expect(readDeployToken(token, TOKEN_SECRET)).toEqual({ projectId: child.id })

      // Deliberately put a sibling in the untrusted request field. The release must take ownership
      // from the signed token, which is the seam where a correct exchange could still be undone.
      const sibling = children.find((candidate) => candidate.id !== child.id)
      // eslint-disable-next-line no-await-in-loop -- each token gets a real deployment row.
      const released = await post(
        "/v1/deploy/release",
        {
          project: sibling?.slug ?? child.slug,
          key: `builds/${child.id}/${DIGEST}.zip`,
          digest: DIGEST,
          preset: "hono",
          environment: "production",
          commit: child.id,
          ref: "refs/heads/main",
        },
        token,
      )
      if (released.status !== 200) {
        throw new Error(`release failed: ${JSON.stringify(released.json)}`)
      }

      // eslint-disable-next-line no-await-in-loop -- evidence is the durable row, not HTTP 200.
      const deployment = await db
        .selectFrom("deployment")
        .select("projectId")
        .where("id", "=", released.json.deployment_id as string)
        .executeTakeFirstOrThrow()
      expect(deployment.projectId).toBe(child.id)
    }
  })

  it("refuses the group because it has nothing to deploy", async () => {
    const response = await post("/v1/deploy/token", {
      oidc_token: "verified-by-the-test-boundary",
      project: group.slug,
    })

    expect(response.status).toBe(400)
    expect(response.json.message).toContain("project group")
    expect(response.json.message).toContain("does not deploy")
  })

  it("refuses an omitted project and lists all four candidates", async () => {
    const response = await post("/v1/deploy/token", {
      oidc_token: "verified-by-the-test-boundary",
    })

    expect(response.status).toBe(400)
    expect(response.json.message).toContain("has 4 deployable projects")
    for (const child of children) expect(response.json.message).toContain(child.slug)
  })
})
