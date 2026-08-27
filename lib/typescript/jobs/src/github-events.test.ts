import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { GITHUB_EVENT_HANDLERS, GITHUB_EVENT_KINDS } from "./github-events"

/**
 * Against the docker-compose Postgres: every assertion here is about a row that appears or does
 * not, which is the whole subject.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let projectId: string
let repositoryId: string
let githubRepoId: string

const LOGIN = "acme-webhook-test"
const context = () => ({ db, keepAlive: () => Promise.resolve(true) }) as never
const job = (payload: unknown) => ({ payload }) as never
const run = (kind: string, body: unknown) =>
  GITHUB_EVENT_HANDLERS[kind](job({ event: kind, delivery: v7(), body }), context())

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  projectId = v7()
  repositoryId = v7()
  githubRepoId = String(Date.now() % 1_000_000_000)

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `gh-${ownerUserId}@test.invalid`, name: "GH" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "GH Org",
      slug: `gh-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId,
      ownerLogin: LOGIN,
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "GH Project",
      slug: `gh-${projectId.slice(-12)}`,
      productionBranch: "main",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("githubInstallation").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("deployment").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

/*
  Every one of these events was verified, queued, and left sitting in `background_job` with no
  handler to run it. The receiver dispatches on event type and names five kinds; none existed.
*/
describe("installation events", () => {
  const installation = (action: string, id: number) => ({
    action,
    installation: {
      id,
      account: { login: LOGIN, type: "User" },
      repository_selection: "all",
      permissions: { contents: "write" },
    },
  })

  it("records an installation against the organization owning that account", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.installationSync, installation("created", 999_001))

    const row = await db
      .selectFrom("githubInstallation")
      .select(["organizationId", "accountLogin", "repositorySelection"])
      .where("installationId", "=", "999001")
      .executeTakeFirst()

    expect(row?.organizationId).toBe(organizationId)
    expect(row?.accountLogin).toBe(LOGIN)
    expect(row?.repositorySelection).toBe("all")
  })

  /*
    GitHub reuses the installation id across `created`, `new_permissions_accepted`, `suspend` and
    `unsuspend`. Inserting on each would give one installation several rows, and whichever was read
    first would win.
  */
  it("updates rather than duplicating when the same installation is sent again", async ({
    skip,
  }) => {
    if (!reachable) skip()

    await run(
      GITHUB_EVENT_KINDS.installationSync,
      installation("new_permissions_accepted", 999_001),
    )

    const rows = await db
      .selectFrom("githubInstallation")
      .select(["id"])
      .where("installationId", "=", "999001")
      .execute()
    expect(rows).toHaveLength(1)
  })

  /*
    An installation on an account no organization here owns is kept out of the table rather than
    guessed at. Attaching it to the wrong organization would hand one customer a token for another
    customer's repositories.
  */
  it("refuses to guess an organization for an unknown account", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.installationSync, {
      action: "created",
      installation: {
        id: 999_002,
        account: { login: "somebody-else-entirely", type: "User" },
      },
    })

    const row = await db
      .selectFrom("githubInstallation")
      .select(["id"])
      .where("installationId", "=", "999002")
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })

  it("removes the row when the installation is deleted", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.installationSync, installation("deleted", 999_001))

    const row = await db
      .selectFrom("githubInstallation")
      .select(["id"])
      .where("installationId", "=", "999001")
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })
})

describe("push events", () => {
  const push = (ref: string, after: string) => ({
    ref,
    after,
    repository: { id: Number(githubRepoId) },
  })

  it("deploys a push to the production branch", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.push, push("refs/heads/main", "a".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["kind", "gitSha", "status"])
      .where("projectId", "=", projectId)
      .where("gitSha", "=", "a".repeat(40))
      .executeTakeFirst()

    expect(deployment?.kind).toBe("production")
    expect(deployment?.status).toBe("queued")
  })

  it("ignores a push to any other branch", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.push, push("refs/heads/some-feature", "b".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["id"])
      .where("projectId", "=", projectId)
      .where("gitSha", "=", "b".repeat(40))
      .executeTakeFirst()
    expect(deployment).toBeUndefined()
  })

  /*
    A branch delete pushes all zeros. Deploying that would build nothing, at a commit that is gone.
  */
  it("ignores a branch deletion", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.push, push("refs/heads/main", "0".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["id"])
      .where("projectId", "=", projectId)
      .where("gitSha", "=", "0".repeat(40))
      .executeTakeFirst()
    expect(deployment).toBeUndefined()
  })

  it("ignores a tag push", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.push, push("refs/tags/v1.0.0", "c".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["id"])
      .where("projectId", "=", projectId)
      .where("gitSha", "=", "c".repeat(40))
      .executeTakeFirst()
    expect(deployment).toBeUndefined()
  })
})

describe("pull request events", () => {
  const pr = (action: string, sha: string) => ({
    action,
    repository: { id: Number(githubRepoId) },
    pull_request: { number: 42, head: { sha, ref: "feature" } },
  })

  it("does not invent an artifactless preview when a PR opens", async ({ skip }) => {
    if (!reachable) skip()

    await run(GITHUB_EVENT_KINDS.pullRequest, pr("opened", "d".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["kind", "prNumber", "status"])
      .where("projectId", "=", projectId)
      .where("gitSha", "=", "d".repeat(40))
      .executeTakeFirst()

    expect(deployment).toBeUndefined()
  })

  /*
    Torn down, not deleted. `usage_event` references a deployment for as long as its billing history
    exists, so a preview cannot take the evidence behind its own charges with it — and `torn_down`
    is what the deploy handler checks before doing anything, so it stops the revision too.
  */
  it("tears the preview down when the PR closes", async ({ skip }) => {
    if (!reachable) skip()

    const previewId = v7()
    await db
      .insertInto("deployment")
      .values({
        id: previewId,
        projectId,
        kind: "preview",
        prNumber: 42,
        gitSha: "d".repeat(40),
        status: "ready",
      })
      .execute()

    await run(GITHUB_EVENT_KINDS.pullRequest, pr("closed", "d".repeat(40)))

    const deployment = await db
      .selectFrom("deployment")
      .select(["id", "status"])
      .where("projectId", "=", projectId)
      .where("prNumber", "=", 42)
      .executeTakeFirst()
    expect(deployment?.status).not.toBe("torn_down")
    const teardown = await db
      .selectFrom("backgroundJob")
      .select("kind")
      .where("idempotencyKey", "=", `deploy.preview_teardown:${deployment?.id ?? "missing"}`)
      .executeTakeFirst()
    expect(teardown?.kind).toBe("deploy.preview_teardown")
  })
})

/*
  A kind with no handler is a row that fails, retries to its limit, and sits in `background_job`
  forever — which makes a queue full of unprocessable work look exactly like a queue that is behind.
*/
describe("every kind the receiver can produce", () => {
  it("has a handler", () => {
    for (const kind of Object.values(GITHUB_EVENT_KINDS)) {
      expect(GITHUB_EVENT_HANDLERS[kind]).toBeTypeOf("function")
    }
  })

  it("acknowledges a ping without needing anything from the body", async ({ skip }) => {
    if (!reachable) skip()
    await expect(run(GITHUB_EVENT_KINDS.ping, { zen: "x" })).resolves.toBeUndefined()
  })

  it("acknowledges an event it does not handle", async ({ skip }) => {
    if (!reachable) skip()
    await expect(run(GITHUB_EVENT_KINDS.unhandled, {})).resolves.toBeUndefined()
  })

  it("records who committed, on any branch, not only production", async ({ skip }) => {
    if (!reachable) skip()

    /*
      A feature branch, deliberately.

      §2's fee turns on how many people are committing to the repository, and a team of three
      working on feature branches is still a team of three. Recording only production pushes would
      undercount every team that reviews before merging — which is every team.
    */
    await run("github.push", {
      repository: { id: Number(githubRepoId) },
      ref: "refs/heads/some-feature",
      after: "a".repeat(40),
      commits: [
        { author: { username: "ada", email: "ada@example.com" } },
        { author: { username: "grace", email: "grace@example.com" } },
        // A rebase: the author and the committer differ, and both used the platform.
        {
          author: { username: "ada", email: "ada@example.com" },
          committer: { username: "alan", email: "alan@example.com" },
        },
      ],
    })

    const recorded = await db
      .selectFrom("repositoryCommitter")
      .select("identity")
      .where("repositoryId", "=", repositoryId)
      .execute()

    expect(recorded.map((row) => row.identity).sort()).toEqual(["ada", "alan", "grace"])
  })
})
