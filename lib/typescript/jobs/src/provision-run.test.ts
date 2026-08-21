import { crudProjectJob, initialSteps, type ProjectJobStep } from "@lib/dao/projectJob/crud"
import { createGitHubClient } from "@lib/github"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { DEPLOY_KINDS } from "./deploy"
import { runProvision } from "./provision"

/**
 * A fork has to end in a deploy, and for the life of the platform it did not.
 *
 * `runProvision` forked the repository, marked `first_deploy` as `skipped`, and set the project to
 * `ready`. A customer got a repository on GitHub and a project that said it was ready while nothing
 * had ever been built and nothing was serving. The `deployment` table held exactly one row, from a
 * seed, on a live deployment that had taken real forks.
 *
 * The assertion is deliberately about the row and the queued job rather than about the step label:
 * marking `first_deploy` succeeded is what the old code could have done without doing any of this.
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
  table:
    | "projectJob"
    | "deployment"
    | "project"
    | "repository"
    | "organization"
    | "user"
    | "storeListing"
  id: string
}[] = []

/** GitHub, answering the two calls provisioning makes: the fork, then the re-read, then the sha. */
function fakeGitHub(sha: string) {
  const repository = {
    id: 424242,
    node_id: "R_kg",
    name: "astro-blog-starter",
    full_name: "acme/astro-blog-starter",
    owner: { login: "acme", type: "User" },
    private: false,
    fork: true,
    default_branch: "main",
    html_url: "https://github.com/acme/astro-blog-starter",
    clone_url: "https://github.com/acme/astro-blog-starter.git",
  }

  const seen: string[] = []
  const client = createGitHubClient({
    fetch: ((url: string | URL) => {
      const path = new URL(String(url)).pathname
      seen.push(path)
      const body = path.includes("/commits/") ? { sha } : repository
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as typeof fetch,
  })

  return { client, credential: { kind: "user", token: "gho_test" } as const, seen }
}

async function seed() {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const suffix = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `prov-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `prov-${suffix}`, name: "Prov", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: -BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: "astro-blog-starter",
      upstreamFullName: "withastro/astro",
      provenance: "fork",
    })
    .execute()
  created.push({ table: "repository", id: repoId })
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "Astro Blog Starter",
      slug: `prov${suffix.slice(0, 6)}`,
      state: "creating",
    })
    .execute()
  created.push({ table: "project", id: projectId })

  const job = await crudProjectJob(db).create({
    id: v7(),
    organizationId: orgId,
    projectId,
    repositoryId: repoId,
    kind: "fork",
    // The API populates these through `provisionProject`; `crudProjectJob.create` leaves the column
    // at its `'[]'` default, and a job with no steps advances nothing.
    steps: JSON.stringify(initialSteps("fork")),
  })
  created.push({ table: "projectJob", id: job.id })

  return { userId, orgId, projectId, repoId, projectJobId: job.id }
}

afterAll(async () => {
  if (!reachable) return
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
})

describe.runIf(reachable)("provisioning a fork", () => {
  it("ends with a production deployment queued for the forked head", async () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    const { userId, orgId, projectId, projectJobId } = await seed()
    const github = fakeGitHub(sha)

    await runProvision(db, { projectJobId, userId }, github)

    const deployment = await db
      .selectFrom("deployment")
      .select(["id", "kind", "gitSha", "gitRef", "status"])
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    expect(deployment).toBeDefined()
    created.push({ table: "deployment", id: deployment!.id })
    expect(deployment).toMatchObject({
      kind: "production",
      gitSha: sha,
      gitRef: "main",
      status: "queued",
    })

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload"])
      .where("idempotencyKey", "=", `${DEPLOY_KINDS.revision}:${deployment!.id}`)
      .executeTakeFirst()

    expect(queued?.kind).toBe(DEPLOY_KINDS.revision)
    expect(queued?.payload).toMatchObject({ deploymentId: deployment!.id })

    // The step record has to agree with what happened, since it is the only thing the customer sees.
    const job = await db
      .selectFrom("projectJob")
      .select(["state", "steps", "progress"])
      .where("id", "=", projectJobId)
      .executeTakeFirstOrThrow()
    const steps = job.steps as ProjectJobStep[]
    expect(steps.find((step) => step.key === "first_deploy")?.state).toBe("succeeded")
    expect(job.state).toBe("succeeded")

    // The row now records the repository GitHub actually returned, not the pending placeholder.
    const repository = await db
      .selectFrom("repository")
      .select(["githubRepoId", "defaultBranch"])
      .where("organizationId", "=", orgId)
      .executeTakeFirstOrThrow()
    expect(BigInt(repository.githubRepoId)).toBe(424242n)
    expect(repository.defaultBranch).toBe("main")

    // The sha came from a real lookup against the fork, not from the fork response.
    expect(github.seen.some((path) => path.includes("/commits/main"))).toBe(true)
  })

  it("counts the install only once the repository exists", async () => {
    /*
      `install_count` is the number on every store card labelled "INSTALLS", and it was incremented
      by the API three lines after queueing this job — before anything had been forked. Two failed
      forks of the same listing, both ending in `NoUsableCredentialError` with no repository
      anywhere, read as two installs on the live catalogue.
    */
    const listingId = v7()
    await db
      .insertInto("storeListing")
      .values({
        id: listingId,
        slug: `prov-${listingId.slice(-10)}`,
        name: "Fixture",
        tagline: "A listing to count against",
        descriptionMd: "",
        upstreamHost: "github.com",
        upstreamOwner: "acme",
        upstreamRepo: "fixture",
        upstreamRepoUrl: "https://github.com/acme/fixture",
      })
      .execute()
    created.push({ table: "storeListing", id: listingId })

    const seeded = await seed()
    await db
      .updateTable("project")
      .set({ storeListingId: listingId })
      .where("id", "=", seeded.projectId)
      .execute()

    const before = await installCount(listingId)
    await runProvision(
      db,
      { projectJobId: seeded.projectJobId, userId: seeded.userId },
      fakeGitHub("b".repeat(40)),
    )

    const deployment = await db
      .selectFrom("deployment")
      .select(["id"])
      .where("projectId", "=", seeded.projectId)
      .executeTakeFirstOrThrow()
    created.push({ table: "deployment", id: deployment.id })

    expect(await installCount(listingId)).toBe(before + 1)

    const events = await db
      .selectFrom("storeListingEvent")
      .select(["kind"])
      .where("storeListingId", "=", listingId)
      .execute()
    expect(events.map((row) => row.kind)).toEqual(["fork_completed"])
  })
})

async function installCount(listingId: string): Promise<number> {
  const row = await db
    .selectFrom("storeListing")
    .select(["installCount"])
    .where("id", "=", listingId)
    .executeTakeFirstOrThrow()
  return row.installCount
}
