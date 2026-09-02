import type { GitHubClient, GitHubCredential, GitHubResponse } from "@lib/github"
import {
  GitHubAuthError,
  installationToken,
  organizationGitHubCredential,
  userGitHubCredential,
  userToken,
} from "@lib/github"
import { db } from "@sproutos/db"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { v7 } from "uuid"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"
import {
  createAndroidAppsRoute,
  RepositoryReadUnavailableError,
  repositoryHeadSha,
} from "./android-apps"

const input = {
  organizationId: v7(),
  userId: v7(),
  owner: "TestSproutOS",
  repository: "selected-repository",
  repositoryId: 12345,
  branch: "main",
}
const path = "/repos/TestSproutOS/selected-repository/git/ref/heads/main"
const rateLimit = { limit: 5_000, remaining: 4_999, resetAt: null }
const appCredential = installationToken("app-token", 99, new Date(Date.now() + 60_000))
const initiatingUserCredential = userToken("user-token")

function response(sha: string) {
  return { status: 200, data: { object: { sha } }, rateLimit }
}

function dependencies(fixture: {
  request: (credential: GitHubCredential) => Promise<ReturnType<typeof response>>
  organizationCredential?: GitHubCredential
  userCredential?: GitHubCredential
}) {
  const requestMock = vi.fn<(credential: GitHubCredential) => Promise<ReturnType<typeof response>>>(
    fixture.request,
  )
  const organizationCredential = vi.fn<typeof organizationGitHubCredential>(() =>
    Promise.resolve(fixture.organizationCredential),
  )
  const userCredential = vi.fn<typeof userGitHubCredential>(() =>
    Promise.resolve(fixture.userCredential),
  )
  return {
    client: {
      request: async <T>(request: Parameters<GitHubClient["request"]>[0]) =>
        (await requestMock(request.credential)) as GitHubResponse<T>,
    },
    organizationCredential,
    requestMock,
    userCredential,
  }
}

describe("repositoryHeadSha", () => {
  it("uses the repository-scoped App credential first", async () => {
    const deps = dependencies({
      organizationCredential: appCredential,
      userCredential: initiatingUserCredential,
      request: () => Promise.resolve(response("a".repeat(40))),
    })

    await expect(repositoryHeadSha(input, deps)).resolves.toBe("a".repeat(40))
    expect(deps.requestMock).toHaveBeenCalledWith(appCredential)
    expect(deps.organizationCredential).toHaveBeenCalledOnce()
    expect(deps.userCredential).not.toHaveBeenCalled()
  })

  it("falls back to the initiating user when a selected-repository App returns 403", async () => {
    const credentials: GitHubCredential[] = []
    const deps = dependencies({
      organizationCredential: appCredential,
      userCredential: initiatingUserCredential,
      request: (credential) => {
        credentials.push(credential)
        if (credential.kind === "installation") {
          return Promise.reject(
            new GitHubAuthError(403, path, "Resource not accessible by integration"),
          )
        }
        return Promise.resolve(response("b".repeat(40)))
      },
    })

    await expect(repositoryHeadSha(input, deps)).resolves.toBe("b".repeat(40))
    expect(credentials).toStrictEqual([appCredential, initiatingUserCredential])
    expect(deps.userCredential).toHaveBeenCalledOnce()
  })

  it("returns one bounded domain failure when neither authorized credential can read", async () => {
    const deps = dependencies({
      organizationCredential: appCredential,
      userCredential: initiatingUserCredential,
      request: () =>
        Promise.reject(
          new GitHubAuthError(403, path, "provider detail that must not reach the caller"),
        ),
    })

    await expect(repositoryHeadSha(input, deps)).rejects.toBeInstanceOf(
      RepositoryReadUnavailableError,
    )
  })
})

const reachable = await databaseReachable()

describe.skipIf(!reachable)("Android setup-commit verification route", () => {
  let owner: TestUser
  let stranger: TestUser
  let organizationSlug: string
  let projectId: string

  beforeAll(async () => {
    owner = await createTestUser("androidverifyowner")
    stranger = await createTestUser("androidverifystranger")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ name: "Android Verify Route" }),
    })
    if (created.status !== 201) throw new Error(`organization fixture returned ${created.status}`)
    const organization = (await created.json()) as { id: string; slug: string }
    trackOrganization(organization.id)
    organizationSlug = organization.slug

    const repositoryId = v7()
    projectId = v7()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId: organization.id,
        githubRepoId: 12_345n,
        ownerLogin: "TestSproutOS",
        name: "selected-repository",
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId: organization.id,
        repositoryId,
        name: "Android Verify Fixture",
        slug: `androidverify${projectId.slice(-8)}`,
        productionBranch: "main",
      })
      .execute()
    await db
      .insertInto("androidApp")
      .values({
        id: v7(),
        projectId,
        packageName: `me.sproutos.app.p${projectId.replaceAll("-", "")}`,
      })
      .execute()
  })

  afterAll(async () => {
    await cleanupFixtures()
    await db.destroy()
  })

  it("turns credential exhaustion into an actionable 409 without provider detail", async () => {
    const route = createAndroidAppsRoute({
      repositoryHeadSha: () => Promise.reject(new RepositoryReadUnavailableError()),
    })
    const result = await route.request(
      `/${organizationSlug}/projects/${projectId}/android/verify`,
      {
        method: "POST",
        headers: authHeaders(owner),
        body: JSON.stringify({ commit: "c".repeat(40) }),
      },
    )

    expect(result.status).toBe(409)
    const body = await result.text()
    expect(body).toContain("Grant the SproutOS GitHub App access")
    expect(body).not.toContain("Resource not accessible by integration")
  })

  it("enforces project:update before invoking any credential fallback", async () => {
    const read = vi.fn<typeof repositoryHeadSha>(() => Promise.resolve("c".repeat(40)))
    const route = createAndroidAppsRoute({ repositoryHeadSha: read })
    const result = await route.request(
      `/${organizationSlug}/projects/${projectId}/android/verify`,
      {
        method: "POST",
        headers: authHeaders(stranger),
        body: JSON.stringify({ commit: "c".repeat(40) }),
      },
    )

    expect(result.status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })
})
