import { crudProjectJob, initialSteps, type ProjectJobStep } from "@lib/dao/projectJob/crud"
import { createGitHubClient } from "@lib/github"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { enqueue } from "./queue"
import { provisionProjectJobHandler, runProvision, STALE_AFTER_MS } from "./provision"
import { runOne } from "./worker"

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
    | "deploymentCatalogueImport"
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

/**
 * A project pointed at a repository the customer already has.
 *
 * TASK 21's third way of starting a project: no new `repository` row, no creation on GitHub, and
 * the same `provision` job as everything else. The `github_repo_id` is positive because GitHub
 * assigned it — which is the only thing telling this apart from a placeholder awaiting creation.
 */
async function seedExistingRepository() {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const suffix = repoId.replaceAll("-", "").slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `ex-${userId}@test.invalid`, name: "Ex" })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({
      id: orgId,
      name: "Ex Org",
      slug: `ex${suffix}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      // Positive: GitHub already assigned it. `pendingGithubRepoId` uses the negative half.
      githubRepoId: 424242,
      ownerLogin: "acme",
      name: "astro-blog-starter",
      provenance: "imported",
    })
    .execute()
  created.push({ table: "repository", id: repoId })
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "Existing",
      slug: `ex${suffix.slice(0, 6)}`,
      state: "creating",
    })
    .execute()
  created.push({ table: "project", id: projectId })

  const job = await crudProjectJob(db).create({
    id: v7(),
    organizationId: orgId,
    projectId,
    repositoryId: repoId,
    kind: "provision",
    steps: JSON.stringify(initialSteps("provision")),
  })
  created.push({ table: "projectJob", id: job.id })

  return { userId, orgId, projectId, repoId, projectJobId: job.id }
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
      upstreamStrategy: "github_fork",
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

async function attachTemplate(seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  const catalogueImportId = v7()
  const listingId = v7()
  const manifest = {
    schema_version: 1,
    id: `retry-${listingId}`,
    name: "Retry fixture",
    pitch: "Retry fixture",
    description_md: "Retry fixture",
    homepage: null,
    repository: { url: "https://github.com/acme/retry", commit: "1".repeat(40) },
    license: "MIT",
    platform: "web",
    readiness: {
      status: "live",
      blocked_reasons: [],
      e2e_evidence: {
        workflow_run_url: "https://github.com/MySproutOS/Deployment-Templates/actions/runs/1",
        tested_at: "2026-08-28T00:00:00.000Z",
        upstream_commit: "1".repeat(40),
        plugin_digest: `sha256:${"2".repeat(64)}`,
      },
    },
    plugin: {
      repository: "ghcr.io/mysproutos/retry",
      digest: `sha256:${"2".repeat(64)}`,
      protocol_version: 1,
    },
    deployment: {
      preset: "static",
      runtime: "static",
      architecture: "arm64",
      migration: null,
      required_capabilities: [],
    },
    services: [
      {
        key: "database",
        kind: "postgres",
        bindings: [{ environment: "DATABASE_URL", output: "connection_url" }],
      },
    ],
    user_inputs: [],
    generated_inputs: [],
  }

  await db
    .insertInto("deploymentCatalogueImport")
    .values({
      id: catalogueImportId,
      ociRepository: "ghcr.io/mysproutos/deployment-catalogue",
      ociDigest: `sha256:${"3".repeat(64)}`,
      catalogueDigest: `sha256:${"4".repeat(64)}`,
      sourceRepository: "MySproutOS/Deployment-Templates",
      workflowRef: "fixture@refs/heads/main",
      sourceRef: "refs/heads/main",
      sourceSha: "5".repeat(40),
      signatureIdentity: "fixture",
      signatureIssuer: "fixture",
      provenance: { fixture: true },
    })
    .execute()
  created.push({ table: "deploymentCatalogueImport", id: catalogueImportId })
  await db
    .insertInto("storeListing")
    .values({
      id: listingId,
      slug: `retry-${listingId.slice(-10)}`,
      name: "Retry fixture",
      tagline: "Retry fixture",
      descriptionMd: "Retry fixture",
      upstreamOwner: "acme",
      upstreamRepo: "retry",
      upstreamRepoUrl: "https://github.com/acme/retry",
      catalogueEntryId: manifest.id,
      catalogueImportId,
      catalogueSchemaVersion: 1,
      catalogueManifest: manifest,
      upstreamCommit: manifest.repository.commit,
      templatePluginRepository: manifest.plugin.repository,
      templatePluginDigest: manifest.plugin.digest,
    })
    .execute()
  created.push({ table: "storeListing", id: listingId })
  await db
    .updateTable("project")
    .set({ storeListingId: listingId })
    .where("id", "=", seeded.projectId)
    .execute()
  await db
    .insertInto("projectTemplateInstall")
    .values({
      projectId: seeded.projectId,
      organizationId: seeded.orgId,
      storeListingId: listingId,
      catalogueEntryId: manifest.id,
      catalogueImportId,
      catalogueDigest: `sha256:${"4".repeat(64)}`,
      manifest,
      configuredInputs: JSON.stringify([]),
      manifestDigest: `sha256:${"6".repeat(64)}`,
      pluginRepository: manifest.plugin.repository,
      pluginDigest: manifest.plugin.digest,
      deploymentTemplatesCommit: "5".repeat(40),
      preparedCommitSha: "7".repeat(40),
    })
    .execute()
}

afterAll(async () => {
  if (!reachable) return

  /*
    Deployments first, and by project rather than by id.

    Provisioning creates them as a side effect, so they are not in `created` — and `deployment`
    references `project`, so deleting the project first fails on the foreign key and takes the whole
    teardown with it. Every row after it in the list then survives the run and leaks into the next.
  */
  const projectIds = created.filter((row) => row.table === "project").map((row) => row.id)
  if (projectIds.length > 0) {
    await db.deleteFrom("deployment").where("projectId", "in", projectIds).execute()
    await db.deleteFrom("projectTemplateInstall").where("projectId", "in", projectIds).execute()
  }
  const organizationIds = created.filter((row) => row.table === "organization").map((row) => row.id)
  if (organizationIds.length > 0) {
    await db.deleteFrom("backgroundJob").where("organizationId", "in", organizationIds).execute()
  }

  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
})

describe.runIf(reachable)("provisioning a fork", () => {
  /*
    The first deploy is `skipped`, and no deployment row is written.

    It used to queue one and mark the step `succeeded`. Under Knative that worked — the release
    handler found no image and triggered a build. Since ADR 0026 a release carries an *artifact* the
    deploy action uploaded, so the row it wrote had a null `artifact_key` and `publishRelease`
    refused it on sight: "No build artifact was uploaded for this release", not retried.

    Every project in production carried one of those. The step said `succeeded` anyway, which is the
    lie the comment above this code congratulated itself on having removed — grown back one layer
    down, where the step passed and the thing it stood for failed.
  */
  it("skips the first deploy rather than queueing one that cannot succeed", async () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    const { userId, orgId, projectId, projectJobId } = await seed()
    const github = fakeGitHub(sha)

    await runProvision(db, { projectJobId, userId }, github)

    const deployment = await db
      .selectFrom("deployment")
      .select(["id"])
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    expect(deployment).toBeUndefined()

    const job = await db
      .selectFrom("projectJob")
      .select(["state", "steps", "progress"])
      .where("id", "=", projectJobId)
      .executeTakeFirstOrThrow()
    const steps = job.steps as ProjectJobStep[]
    expect(steps.find((step) => step.key === "first_deploy")?.state).toBe("skipped")
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

    /*
      Asserted on the job, not on a deployment row.

      This used to read the deployment as a proxy for "provisioning finished", which stopped meaning
      anything when provisioning stopped writing one — the deploy it queued could only ever fail.
      The job's own state is the fact this test is about.
    */
    const job = await db
      .selectFrom("projectJob")
      .select(["state"])
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job.state).toBe("succeeded")

    expect(await installCount(listingId)).toBe(before + 1)

    const events = await db
      .selectFrom("storeListingEvent")
      .select(["kind"])
      .where("storeListingId", "=", listingId)
      .execute()
    expect(events.map((row) => row.kind)).toEqual(["fork_completed"])
  })
})

describe.runIf(reachable)("a provisioning job left running by a worker that died", () => {
  /*
    `state = 'queued'` was the whole claim condition, and it strands a project permanently.

    There is no lease on a `project_job`, so a worker that claimed one and then died leaves it
    `running` with nobody on it — and the next attempt of the background job finds nothing to claim,
    returns, and reports **success**. Observed exactly that way on the live deployment:
    `project.provision succeeded` on attempt 2 beside a `project_job` still `running`, a fork that
    never happened, and a project the customer sees as "Building" forever.
  */
  it("is reclaimed once it has been silent long enough", async () => {
    const seeded = await seed()
    await db
      .updateTable("projectJob")
      .set({
        state: "running",
        updatedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000),
      })
      .where("id", "=", seeded.projectJobId)
      .execute()

    await runProvision(
      db,
      { projectJobId: seeded.projectJobId, userId: seeded.userId },
      fakeGitHub("c".repeat(40)),
    )

    // The job ran to completion, which is what "reclaimed" means. It used to be read off a
    // deployment row that provisioning no longer writes.
    const job = await db
      .selectFrom("projectJob")
      .select(["state"])
      .where("id", "=", seeded.projectJobId)
      .executeTakeFirstOrThrow()
    expect(job.state).toBe("succeeded")
  })

  it("leaves a job alone while another worker is still on it", async () => {
    // The hazard the original condition was reasoning about, and the one it got right: a second
    // concurrent claimant must not fork the same repository twice.
    const seeded = await seed()
    await db
      .updateTable("projectJob")
      .set({ state: "running", updatedAt: new Date() })
      .where("id", "=", seeded.projectJobId)
      .execute()

    const github = fakeGitHub("d".repeat(40))
    await runProvision(db, { projectJobId: seeded.projectJobId, userId: seeded.userId }, github)

    expect(github.seen).toEqual([])
    expect(
      await db
        .selectFrom("deployment")
        .select(["id"])
        .where("projectId", "=", seeded.projectId)
        .execute(),
    ).toEqual([])
  })
})

describe.runIf(reachable)("a provider response lost inside the background worker", () => {
  it("requeues the project job so the background retry reaches provider reconciliation", async () => {
    const seeded = await seed()
    await attachTemplate(seeded)
    // Keep this worker scoped to the row under test. The full suite leaves legitimate
    // project.provision work queued, and runOne correctly chooses the oldest matching row.
    const queueKind = `test.project.provision.retry.${v7()}`
    const backgroundJobId = await enqueue(db, {
      kind: queueKind,
      organizationId: seeded.orgId,
      payload: { projectJobId: seeded.projectJobId, userId: seeded.userId },
      maxAttempts: 2,
    })
    let providerCalls = 0
    let providerResources = 0
    const handler = provisionProjectJobHandler({
      github: fakeGitHub("8".repeat(40)),
      provisionServices: () => {
        providerCalls += 1
        if (providerResources === 0) {
          providerResources += 1
          return Promise.reject(new Error("provider applied the mutation but response was lost"))
        }
        return Promise.resolve()
      },
    })
    const options = {
      workerId: `retry-${v7()}`,
      handlers: { [queueKind]: handler },
      leaseSeconds: 300,
    }

    await runOne(db, options)

    expect(
      await db
        .selectFrom("projectJob")
        .select(["state", "errorMessage"])
        .where("id", "=", seeded.projectJobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "queued",
      errorMessage: "provider applied the mutation but response was lost",
    })
    expect(
      await db
        .selectFrom("projectTemplateInstall")
        .select("state")
        .where("projectId", "=", seeded.projectId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "provisioning" })
    expect(
      await db
        .selectFrom("backgroundJob")
        .select(["state", "attempt"])
        .where("id", "=", backgroundJobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "queued", attempt: 1 })

    await db
      .updateTable("backgroundJob")
      .set({ runAt: new Date(Date.now() - 1_000) })
      .where("id", "=", backgroundJobId)
      .execute()
    await runOne(db, options)

    expect(providerCalls).toBe(2)
    expect(providerResources).toBe(1)
    expect(
      await db
        .selectFrom("projectJob")
        .select(["state", "errorMessage"])
        .where("id", "=", seeded.projectJobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "succeeded", errorMessage: null })
    expect(
      await db
        .selectFrom("backgroundJob")
        .select(["state", "attempt"])
        .where("id", "=", backgroundJobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "succeeded", attempt: 2 })
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

/*
  The third way of starting a project asked GitHub to create a repository the customer already had.

  `provisionProject` writes no `repository` row for `mode: "existing"` — it points a project at one
  that is already there — and queues the same `provision` job. Provisioning created unconditionally,
  so GitHub answered 422 "name already exists on this account" and the step failed on its first
  call, every time. Nothing distinguished the two cases except the sign of `github_repo_id`, which
  nothing consulted.
*/
describe.runIf(reachable)("provisioning onto a repository that already exists", () => {
  it("reads the repository instead of trying to create it", async () => {
    const sha = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567"
    const { userId, projectJobId } = await seedExistingRepository()
    const github = fakeGitHub(sha)

    await runProvision(db, { projectJobId, userId }, github)

    // The creation endpoints, either of which is the 422 this guards against.
    expect(github.seen).not.toContain("/user/repos")
    expect(github.seen.some((path) => /^\/orgs\/[^/]+\/repos$/.test(path))).toBe(false)

    // And it did read the one that exists.
    expect(github.seen).toContain("/repos/acme/astro-blog-starter")
  })

  it("writes no deployment for a project on an existing repository either", async () => {
    const sha = "1122334455667788990011223344556677889900"
    const { userId, projectId } = await (async () => {
      const seeded = await seedExistingRepository()
      await runProvision(
        db,
        { projectJobId: seeded.projectJobId, userId: seeded.userId },
        fakeGitHub(sha),
      )
      return seeded
    })()

    const deployment = await db
      .selectFrom("deployment")
      .select(["gitSha", "status"])
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    expect(deployment).toBeUndefined()
    expect(userId).toBeDefined()
  })
})
