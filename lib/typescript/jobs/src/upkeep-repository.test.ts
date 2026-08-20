import type { GitHubClient, GitHubRequest } from "@lib/github"
import { GitHubApiError, installationToken } from "@lib/github"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { upkeepRepository, type UpkeepDeps } from "./upkeep-repository"
import type { Job } from "./queue"

/**
 * Against the compose Postgres, with GitHub stubbed.
 *
 * The half worth testing is the half that touches the database: which outcome gets recorded, and
 * whether a conflict reaches the projects subscribed to the fork. `fetchUpkeepStatus` reads those
 * rows back to decide whether upkeep is paused, so an outcome recorded under the wrong name is a
 * fork that either stops updating or never stops retrying.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: {
  table: "project" | "repository" | "githubInstallation" | "organization" | "user"
  id: string
}[] = []

async function seed(options: { behindBy: number; aheadBy: number }) {
  const userId = v7()
  const orgId = v7()
  const installId = v7()
  const repoId = v7()
  const projectId = v7()
  // The *tail*, not the head: UUIDv7 begins with a millisecond timestamp, so three seeds inside
  // one tick share their first characters and collide on `user_email_key`.
  const suffix = repoId.slice(-12)
  // GitHub's numeric ids are globally unique columns, so the seeds need distinct ones. Derived
  // from the uuid's random tail rather than a counter, so a reused database stays collision-free.
  const githubId = BigInt(`0x${suffix}`)

  await db
    .insertInto("user")
    .values({ id: userId, email: `upkeep-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })

  await db
    .insertInto("organization")
    .values({
      id: orgId,
      slug: `upkeep-${suffix}`,
      name: "Upkeep",
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  created.push({ table: "organization", id: orgId })

  await db
    .insertInto("githubInstallation")
    .values({
      id: installId,
      organizationId: orgId,
      installationId: githubId,
      accountLogin: "acme",
      accountType: "Organization",
    })
    .execute()
  created.push({ table: "githubInstallation", id: installId })

  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: githubId,
      ownerLogin: "acme",
      name: `fork-${suffix}`,
      defaultBranch: "main",
      provenance: "fork",
      isFork: true,
      upstreamFullName: "upstream/app",
      upstreamDefaultBranch: "main",
      githubInstallationId: installId,
    })
    .execute()
  created.push({ table: "repository", id: repoId })

  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "App",
      slug: `app-${suffix}`,
      autoUpdateEnabled: true,
    })
    .execute()
  created.push({ table: "project", id: projectId })

  return { orgId, repoId, projectId, options }
}

/** A client that answers the compare and records what the merge attempt did. */
function stubClient(
  compare: unknown,
  onMerge: () => { status: number; data: unknown },
): { client: GitHubClient; calls: string[] } {
  const calls: string[] = []

  const client: GitHubClient = {
    request: async <T>(request: GitHubRequest) => {
      calls.push(`${request.method} ${request.path}`)
      const rateLimit = { limit: null, remaining: null, resetAt: null }

      if (request.path.includes("/compare/")) {
        return Promise.resolve({ status: 200, data: compare as T, rateLimit })
      }

      const merged = onMerge()

      // The real client throws on any non-2xx rather than returning it, and the handler's whole
      // conflict path hangs off that. A stub that returned a 409 as data would let a broken
      // handler pass by never exercising the branch under test.
      if (merged.status >= 300) {
        throw new GitHubApiError(merged.status, request.path, "stubbed failure")
      }

      return Promise.resolve({ status: merged.status, data: merged.data as T, rateLimit })
    },
  }

  return { client, calls }
}

function deps(client: GitHubClient): UpkeepDeps {
  return {
    client,
    credentialFor: (id) =>
      Promise.resolve(installationToken("stub-token", id, new Date(Date.now() + 3_600_000))),
  }
}

/** A live lease and an un-aborted signal — what the worker hands a handler it just claimed. */
const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }

function jobFor(repositoryId: string): Job {
  return {
    id: v7(),
    kind: "upkeep.repository",
    payload: { repositoryId },
    attempt: 1,
    maxAttempts: 2,
    organizationId: null,
  }
}

async function outcomes(repositoryId: string) {
  return await db
    .selectFrom("upstreamSyncRun")
    .select(["outcome", "mergeType", "behindBy", "aheadBy", "upstreamSha"])
    .where("repositoryId", "=", repositoryId)
    .orderBy("createdAt", "desc")
    .execute()
}

afterAll(async () => {
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe.skipIf(!reachable)("upkeepRepository", () => {
  it("records an up-to-date run without calling merge, when upstream has nothing new", async () => {
    const { repoId } = await seed({ behindBy: 0, aheadBy: 3 })
    const { client, calls } = stubClient(
      { status: "behind", ahead_by: 0, behind_by: 3, merge_base_commit: { sha: "base-sha" } },
      () => {
        throw new Error("merge must not be attempted when there is nothing to merge")
      },
    )

    await upkeepRepository(deps(client))(jobFor(repoId), context)

    // The cost thesis in one assertion: discovering there is nothing to do must not spend anything.
    expect(calls.filter((call) => call.includes("merge-upstream"))).toEqual([])

    const [run] = await outcomes(repoId)
    expect(run?.outcome).toBe("up_to_date")
    expect(run?.mergeType).toBe("none")
    expect(run?.aheadBy).toBe(3)
  })

  it("fast-forwards a fork with no local commits and records the merge type", async () => {
    const { repoId } = await seed({ behindBy: 5, aheadBy: 0 })
    const { client } = stubClient(
      {
        status: "ahead",
        ahead_by: 5,
        behind_by: 0,
        commits: [{ sha: "a" }, { sha: "upstream-tip" }],
        files: [{}],
      },
      () => ({ status: 200, data: { merge_type: "fast-forward", base_branch: "main" } }),
    )

    await upkeepRepository(deps(client))(jobFor(repoId), context)

    const [run] = await outcomes(repoId)
    expect(run?.outcome).toBe("up_to_date")
    expect(run?.mergeType).toBe("fast_forward")
    expect(run?.behindBy).toBe(5)
    expect(run?.upstreamSha).toBe("upstream-tip")
  })

  it("records a conflict and tells every subscribed project when GitHub refuses the merge", async () => {
    const { repoId, projectId } = await seed({ behindBy: 4, aheadBy: 2 })
    const { client } = stubClient(
      { status: "diverged", ahead_by: 4, behind_by: 2, commits: [{ sha: "tip" }] },
      () => ({ status: 409, data: { message: "merge conflict between base and head" } }),
    )

    await upkeepRepository(deps(client))(jobFor(repoId), context)

    const [run] = await outcomes(repoId)
    // Not "failed": a conflict is the normal state of a fork someone is working on, and counting
    // it toward the pause limit would stop updates on exactly the repositories being used.
    expect(run?.outcome).toBe("conflict")

    const suggestions = await db
      .selectFrom("projectUpdateSuggestion")
      .select("projectId")
      .where("projectId", "=", projectId)
      .execute()

    expect(suggestions).toHaveLength(1)
  })
})
