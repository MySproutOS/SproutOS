/* oxlint-disable typescript/require-await, vitest/require-mock-type-parameters -- deferred test doubles intentionally return promises */
import { installationToken } from "@lib/github"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import type { Job } from "./queue"
import { resolveUpkeepConflict, type UpkeepResolutionDeps } from "./upkeep-resolution"
import type { UpstreamConflictInput, UpstreamConflictResolution } from "./upstream-conflict"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const users: string[] = []
const organizations: string[] = []

type Seeded = Awaited<ReturnType<typeof seed>>

async function seed(options: { state?: "queued" | "running"; updatedAt?: Date } = {}) {
  const userId = v7()
  const organizationId = v7()
  const installationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const sessionId = v7()
  const syncRunId = v7()
  const projectJobId = v7()
  const suffix = repositoryId.slice(-12)
  const githubId = BigInt(`0x${suffix}`)
  const targetSha = "1".repeat(40)
  const upstreamSha = "2".repeat(40)

  await db
    .insertInto("user")
    .values({ id: userId, email: `resolution-${suffix}@example.test`, name: "Resolver" })
    .execute()
  users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `resolution-${suffix}`,
      name: "Resolution",
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  organizations.push(organizationId)
  await db
    .insertInto("githubInstallation")
    .values({
      id: installationId,
      organizationId,
      installationId: githubId,
      accountLogin: "customer",
      accountType: "Organization",
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: githubId,
      githubInstallationId: installationId,
      ownerLogin: "customer",
      name: `app-${suffix}`,
      defaultBranch: "main",
      provenance: "fork",
      isFork: true,
      upstreamFullName: "upstream/app",
      upstreamDefaultBranch: "main",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "App",
      slug: `app-${suffix}`,
    })
    .execute()
  await db
    .insertInto("agentSession")
    .values({ id: sessionId, projectId, createdByUserId: userId, title: "Resolve upstream" })
    .execute()
  await db
    .insertInto("upstreamSyncRun")
    .values({
      id: syncRunId,
      repositoryId,
      branch: "main",
      outcome: "conflict",
      forkSha: targetSha,
      upstreamSha,
      aheadBy: 1,
      behindBy: 1,
    })
    .execute()
  await db
    .insertInto("projectJob")
    .values({
      id: projectJobId,
      organizationId,
      projectId,
      repositoryId,
      kind: "sync_upstream",
      state: options.state ?? "queued",
      updatedAt: options.updatedAt ?? new Date(),
      details: {
        upstreamSyncRunId: syncRunId,
        expectedUpstreamSha: upstreamSha,
        expectedTargetSha: targetSha,
        agentSessionId: sessionId,
        userId,
      },
    })
    .execute()

  return {
    userId,
    organizationId,
    repositoryId,
    projectId,
    sessionId,
    syncRunId,
    projectJobId,
    targetSha,
    upstreamSha,
  }
}

function background(seeded: Seeded, attempt = 1, maxAttempts = 3): Job {
  return {
    id: v7(),
    organizationId: seeded.organizationId,
    kind: "upkeep.resolve_conflict",
    payload: { projectJobId: seeded.projectJobId },
    attempt,
    maxAttempts,
  }
}

function resolution(
  overrides: Partial<UpstreamConflictResolution> = {},
): UpstreamConflictResolution {
  return {
    pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/customer/app/pull/41",
    proposedSha: "3".repeat(40),
    patchSha256: "4".repeat(64),
    files: ["app.ts"],
    ...overrides,
  }
}

function dependencies(
  resolve: (input: UpstreamConflictInput) => Promise<UpstreamConflictResolution>,
): UpkeepResolutionDeps {
  return {
    credentialFor: (id, _request) =>
      Promise.resolve(installationToken("test-token", id, new Date(Date.now() + 60_000))),
    resolve: resolve,
  }
}

function context(keepAlive: () => Promise<boolean> = () => Promise.resolve(true)) {
  return { db, keepAlive, signal: new AbortController().signal }
}

afterEach(async () => {
  for (const id of organizations.splice(0)) {
    await db.deleteFrom("organization").where("id", "=", id).execute()
  }
  for (const id of users.splice(0)) {
    await db.deleteFrom("user").where("id", "=", id).execute()
  }
})

afterAll(async () => {
  await db.destroy()
})

describe.skipIf(!reachable)("resolveUpkeepConflict", () => {
  it("records the proposed PR and completes the customer-visible job", async () => {
    const seeded = await seed()
    const resolve = vi.fn(async (_input: UpstreamConflictInput) => resolution())

    await resolveUpkeepConflict(dependencies(resolve))(background(seeded), context())

    expect(resolve).toHaveBeenCalledOnce()
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      expectedTargetSha: seeded.targetSha,
      expectedUpstreamSha: seeded.upstreamSha,
      projectJobId: seeded.projectJobId,
    })
    const job = await db
      .selectFrom("projectJob")
      .select(["state", "progress", "finishedAt"])
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job.state).toBe("succeeded")
    expect(job.progress).toBe(100)
    expect(job.finishedAt).not.toBeNull()

    const proposal = await db
      .selectFrom("upstreamSyncRun")
      .select(["outcome", "pullRequestNumber", "pullRequestUrl", "forkSha", "upstreamSha"])
      .where("repositoryId", "=", seeded.repositoryId)
      .where("outcome", "=", "pr_opened")
      .executeTakeFirstOrThrow()
    expect(proposal).toMatchObject({
      outcome: "pr_opened",
      pullRequestNumber: 41,
      pullRequestUrl: "https://github.com/customer/app/pull/41",
      forkSha: "3".repeat(40),
      upstreamSha: seeded.upstreamSha,
    })
  })

  it("records a stale-base failure and never records a pull request", async () => {
    const seeded = await seed()
    const stale = new Error("repository head changed")
    stale.name = "StaleUpstreamBaseError"
    const resolve = vi.fn(async () => Promise.reject(stale))

    await expect(
      resolveUpkeepConflict(dependencies(resolve))(background(seeded, 3, 3), context()),
    ).rejects.toThrow("repository head changed")

    const job = await db
      .selectFrom("projectJob")
      .select(["state", "errorCode", "errorMessage"])
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job).toMatchObject({
      state: "failed",
      errorCode: "StaleUpstreamBaseError",
      errorMessage: "repository head changed",
    })
    const proposals = await db
      .selectFrom("upstreamSyncRun")
      .select("id")
      .where("repositoryId", "=", seeded.repositoryId)
      .where("outcome", "=", "pr_opened")
      .execute()
    expect(proposals).toEqual([])
  })

  it("lets exactly one worker own a fresh lease", async () => {
    const seeded = await seed()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const resolve = vi.fn(async () => {
      started()
      await blocked
      return resolution()
    })
    const handler = resolveUpkeepConflict(dependencies(resolve))

    const first = handler(background(seeded), context())
    await entered
    await handler(background(seeded), context())
    expect(resolve).toHaveBeenCalledOnce()
    release()
    await first
    expect(resolve).toHaveBeenCalledOnce()
  })

  it("reclaims an expired project-job lease", async () => {
    const seeded = await seed({
      state: "running",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
    })
    const resolve = vi.fn(async () => resolution())

    await resolveUpkeepConflict(dependencies(resolve))(background(seeded, 2), context())

    expect(resolve).toHaveBeenCalledOnce()
    const job = await db
      .selectFrom("projectJob")
      .select(["state", "attempt"])
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job).toMatchObject({ state: "succeeded", attempt: 1 })
  })

  it("checks cancellation immediately before the trusted push", async () => {
    const seeded = await seed()
    const resolve = vi.fn(async (input: UpstreamConflictInput) => {
      await db
        .updateTable("projectJob")
        .set({ state: "canceled" })
        .where("id", "=", seeded.projectJobId)
        .execute()
      await input.mayPush?.()
      throw new Error("push must not be reached")
    })

    await resolveUpkeepConflict(dependencies(resolve))(background(seeded), context())

    const job = await db
      .selectFrom("projectJob")
      .select("state")
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job.state).toBe("canceled")
    const proposals = await db
      .selectFrom("upstreamSyncRun")
      .select("id")
      .where("repositoryId", "=", seeded.repositoryId)
      .where("outcome", "=", "pr_opened")
      .execute()
    expect(proposals).toEqual([])
  })

  it("turns a lost queue lease into a retryable failure, not a successful orphan", async () => {
    const seeded = await seed()
    const resolve = vi.fn(async (input: UpstreamConflictInput) => {
      await input.touch?.()
      return resolution()
    })

    await expect(
      resolveUpkeepConflict(dependencies(resolve))(
        background(seeded),
        context(() => Promise.resolve(false)),
      ),
    ).rejects.toThrow("Lost ownership")

    const job = await db
      .selectFrom("projectJob")
      .select("state")
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job.state).toBe("queued")
  })
})
