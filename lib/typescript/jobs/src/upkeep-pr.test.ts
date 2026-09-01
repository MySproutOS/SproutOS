/* oxlint-disable typescript/require-await -- test client implements an async interface */
import { installationToken, type GitHubClient, type GitHubRequest } from "@lib/github"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import type { Job } from "./queue"
import { finalizeUpkeepPullRequest, UPKEEP_PR_KIND } from "./upkeep-pr"

const reachable = await sql`select 1`.execute(db).then(
  () => true,
  () => false,
)
const organizations: string[] = []
const users: string[] = []

async function fixture() {
  const userId = v7()
  const organizationId = v7()
  const installationId = v7()
  const repositoryId = v7()
  const runId = v7()
  const numeric = BigInt(`0x${repositoryId.replaceAll("-", "").slice(-12)}`)
  await db
    .insertInto("user")
    .values({ id: userId, email: `${userId}@test.invalid` })
    .execute()
  users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      ownerUserId: userId,
      name: "PR",
      slug: `pr-${organizationId}`,
      kind: "personal",
    })
    .execute()
  organizations.push(organizationId)
  await db
    .insertInto("githubInstallation")
    .values({
      id: installationId,
      organizationId,
      installationId: numeric,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: numeric,
      githubInstallationId: installationId,
      ownerLogin: "acme",
      name: `repo-${repositoryId}`,
      defaultBranch: "main",
      provenance: "fork",
      isFork: true,
    })
    .execute()
  await db
    .insertInto("upstreamSyncRun")
    .values({
      id: runId,
      repositoryId,
      branch: "sproutos/upkeep-abc",
      outcome: "pr_opened",
      pullRequestNumber: 12,
      pullRequestUrl: "https://example.test/pr/12",
    })
    .execute()
  return { organizationId, repositoryId, runId, numeric }
}

function job(runId: string, poll = 1): Job {
  return {
    id: v7(),
    organizationId: null,
    kind: UPKEEP_PR_KIND,
    payload: {
      upstreamSyncRunId: runId,
      poll,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    attempt: 1,
    maxAttempts: 3,
  }
}

function client(calls: string[]): GitHubClient {
  return {
    request: async <T>(request: GitHubRequest) => {
      calls.push(`${request.method} ${request.path}`)
      const rateLimit = { limit: null, remaining: null, resetAt: null }
      if (request.path.endsWith("/pulls/12"))
        return {
          status: 200,
          data: {
            state: "open",
            merged: false,
            head: { sha: "head-sha" },
          } as T,
          rateLimit,
        }
      if (request.path.endsWith("/check-runs"))
        return {
          status: 200,
          data: {
            total_count: 1,
            check_runs: [{ status: "completed", conclusion: "success" }],
          } as T,
          rateLimit,
        }
      if (request.path.endsWith("/status"))
        return {
          status: 200,
          data: {
            state: "success",
            statuses: [{ context: "ci" }],
          } as T,
          rateLimit,
        }
      if (request.path.endsWith("/merge"))
        return { status: 200, data: { merged: true, message: "merged" } as T, rateLimit }
      if (request.method === "DELETE") return { status: 204, data: null as T, rateLimit }
      throw new Error(`unexpected ${request.method} ${request.path}`)
    },
  }
}

afterAll(async () => {
  if (!reachable) return
  if (organizations.length > 0)
    await db.deleteFrom("organization").where("id", "in", organizations).execute()
  if (users.length > 0) await db.deleteFrom("user").where("id", "in", users).execute()
  await db.destroy()
})

describe.skipIf(!reachable)("upkeep pull request finalizer", () => {
  it("merges only after successful checks, records completion, and deletes the proposal branch", async () => {
    const row = await fixture()
    const calls: string[] = []
    await finalizeUpkeepPullRequest({
      client: client(calls),
      credentialFor: () =>
        Promise.resolve(
          installationToken("token", Number(row.numeric), new Date(Date.now() + 60_000)),
        ),
    })(job(row.runId), {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })
    const run = await db
      .selectFrom("upstreamSyncRun")
      .select("outcome")
      .where("id", "=", row.runId)
      .executeTakeFirstOrThrow()
    const repository = await db
      .selectFrom("repository")
      .select("lastSyncedAt")
      .where("id", "=", row.repositoryId)
      .executeTakeFirstOrThrow()
    expect(run.outcome).toBe("merged")
    expect(repository.lastSyncedAt).not.toBeNull()
    expect(calls.some((call) => call.endsWith("/merge"))).toBe(true)
    expect(calls.some((call) => call.startsWith("DELETE "))).toBe(true)
  })

  it("does not merge an unprotected repository before any CI check has run", async () => {
    const row = await fixture()
    const calls: string[] = []
    const noChecks: GitHubClient = {
      request: async <T>(request: GitHubRequest) => {
        calls.push(`${request.method} ${request.path}`)
        const rateLimit = { limit: null, remaining: null, resetAt: null }
        if (request.path.endsWith("/pulls/12"))
          return {
            status: 200,
            data: { state: "open", merged: false, head: { sha: "head-sha" } } as T,
            rateLimit,
          }
        if (request.path.endsWith("/check-runs"))
          return { status: 200, data: { total_count: 0, check_runs: [] } as T, rateLimit }
        if (request.path.endsWith("/status"))
          return { status: 200, data: { state: "success", statuses: [] } as T, rateLimit }
        throw new Error(`unexpected ${request.method} ${request.path}`)
      },
    }
    await finalizeUpkeepPullRequest({
      client: noChecks,
      credentialFor: () =>
        Promise.resolve(
          installationToken("token", Number(row.numeric), new Date(Date.now() + 60_000)),
        ),
    })(job(row.runId), {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })
    expect(calls.some((call) => call.endsWith("/merge"))).toBe(false)
    const followup = await db
      .selectFrom("backgroundJob")
      .select("kind")
      .where("idempotencyKey", "=", `${UPKEEP_PR_KIND}:${row.runId}:2`)
      .executeTakeFirst()
    expect(followup?.kind).toBe(UPKEEP_PR_KIND)
  })
})
