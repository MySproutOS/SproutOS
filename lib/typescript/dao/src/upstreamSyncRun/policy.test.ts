import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudUpstreamSyncRun } from "./crud"
import { CONSECUTIVE_FAILURE_LIMIT, fetchUpkeepStatus, type UpkeepOutcome } from "./policy"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created = { users: [] as string[], organizations: [] as string[] }

afterAll(async () => {
  if (!reachable) return
  if (created.organizations.length > 0) {
    await db.deleteFrom("organization").where("id", "in", created.organizations).execute()
  }
  if (created.users.length > 0) {
    await db.deleteFrom("user").where("id", "in", created.users).execute()
  }
  await db.destroy()
})

/** A repository that is a fork, with one project asking for upkeep. */
async function fixture(options: { autoUpdate?: boolean; isFork?: boolean } = {}) {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `upkeep-${userId}@test.invalid`, name: "Upkeep" })
    .execute()
  created.users.push(userId)

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Upkeep Org",
      // The whole id. The leading hex of a UUIDv7 is the millisecond timestamp, so a prefix
      // collides for every fixture built in the same millisecond — which is all of them.
      slug: `upkeep-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  created.organizations.push(organizationId)

  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      // A unique index lives on github_repo_id; derive it from the fixture's own id rather than
      // from the clock, which repeats.
      githubRepoId: BigInt(`0x${repositoryId.replaceAll("-", "").slice(-12)}`),
      ownerLogin: "someone",
      name: `fork-${repositoryId}`,
      defaultBranch: "main",
      provenance: "fork",
      isFork: options.isFork ?? true,
      upstreamFullName: (options.isFork ?? true) ? "upstream/original" : null,
    })
    .execute()

  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Upkeep Project",
      slug: `upkeep-${projectId}`,
      kind: "site",
      rootDir: ".",
      productionBranch: "main",
      state: "ready",
      autoUpdateEnabled: options.autoUpdate ?? true,
      autoUpdateMode: "suggest",
    })
    .execute()

  return { organizationId, repositoryId, projectId }
}

async function recordRuns(repositoryId: string, outcomes: UpkeepOutcome[]) {
  for (const outcome of outcomes) {
    await crudUpstreamSyncRun(db).create({ repositoryId, branch: "main", outcome })
  }
}

describe.skipIf(!reachable)("upkeep status", () => {
  it("counts only the failures at the end of the history", async ({ skip }) => {
    if (!reachable) skip()
    const { repositoryId } = await fixture()
    // Oldest first: two failures, then a success, then two more failures.
    await recordRuns(repositoryId, ["failed", "failed", "up_to_date", "failed", "failed"])

    const status = await fetchUpkeepStatus(db).forRepository(repositoryId)
    // The success breaks the streak. Counting every failure in the history would pause a
    // repository that has been working fine for a month because of a bad week in June.
    expect(status.consecutiveFailures).toBe(2)
    expect(status.paused).toBe(false)
  })

  it("pauses at the limit", async ({ skip }) => {
    if (!reachable) skip()
    const { repositoryId } = await fixture()
    await recordRuns(repositoryId, Array<UpkeepOutcome>(CONSECUTIVE_FAILURE_LIMIT).fill("failed"))

    const status = await fetchUpkeepStatus(db).forRepository(repositoryId)
    expect(status.paused).toBe(true)
    // Upkeep costs the customer tokens on every run. A fork whose upstream has diverged past
    // reconciliation would otherwise fail identically, and bill, every night forever.
    expect(await isDue(repositoryId)).toBe(false)
  })

  it("does not count a conflict as a failure", async ({ skip }) => {
    if (!reachable) skip()
    const { repositoryId } = await fixture()
    await recordRuns(repositoryId, Array<UpkeepOutcome>(CONSECUTIVE_FAILURE_LIMIT).fill("conflict"))

    // A conflict means upstream and the fork both changed the same lines, which is the normal
    // state of a fork someone is actually working on. Counting it would pause exactly the
    // repositories that are being used.
    const status = await fetchUpkeepStatus(db).forRepository(repositoryId)
    expect(status.consecutiveFailures).toBe(0)
    expect(await isDue(repositoryId)).toBe(true)
  })

  it("comes back once a run succeeds", async ({ skip }) => {
    if (!reachable) skip()
    const { repositoryId } = await fixture()
    await recordRuns(repositoryId, Array<UpkeepOutcome>(CONSECUTIVE_FAILURE_LIMIT).fill("failed"))
    expect(await isDue(repositoryId)).toBe(false)

    // Derived from history rather than a counter, so nothing has to remember to reset it.
    await recordRuns(repositoryId, ["up_to_date"])
    expect(await isDue(repositoryId)).toBe(true)
  })
})

describe.skipIf(!reachable)("what is due", () => {
  it("skips a repository nobody asked to keep updated", async ({ skip }) => {
    if (!reachable) skip()
    const { repositoryId } = await fixture({ autoUpdate: false })
    expect(await isDue(repositoryId)).toBe(false)
  })

  it("skips a repository that is not a fork of anything", async ({ skip }) => {
    if (!reachable) skip()
    // Nothing upstream to reconcile against; running the agent would bill for a comparison
    // against nothing.
    const { repositoryId } = await fixture({ isFork: false })
    expect(await isDue(repositoryId)).toBe(false)
  })

  it("lists a repository once even when several projects want upkeep", async ({ skip }) => {
    if (!reachable) skip()
    const { organizationId, repositoryId } = await fixture()

    // TASK 21: projects share repositories. One reconciliation serves all of them, and listing
    // the repository twice would bill twice for one piece of work.
    await db
      .insertInto("project")
      .values({
        id: v7(),
        organizationId,
        repositoryId,
        name: "Second Project",
        slug: `upkeep-second-${repositoryId}`,
        kind: "site",
        // A different root_dir, because project_repository_target_live_key is unique on
        // (organization, repository, root_dir, production_branch) — which is what sharing a
        // repository means in this schema: a monorepo deploying two subdirectories.
        rootDir: "packages/web",
        productionBranch: "main",
        state: "ready",
        autoUpdateEnabled: true,
        autoUpdateMode: "suggest",
      })
      .execute()

    const due = await fetchUpkeepStatus(db).dueForUpkeep()
    expect(due.filter((row) => row.id === repositoryId)).toHaveLength(1)
  })
})

async function isDue(repositoryId: string): Promise<boolean> {
  const due = await fetchUpkeepStatus(db).dueForUpkeep()
  return due.some((row) => row.id === repositoryId)
}
