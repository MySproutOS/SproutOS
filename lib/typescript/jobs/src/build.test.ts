import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { buildImage, buildSettingsFromEnv } from "./build"
import type { Job } from "./queue"

/**
 * Against the compose Postgres, and against a cluster when one is reachable.
 *
 * The cluster half needs `KUBE_SERVER` *and* `BUILD_REGISTRY` — a registry the cluster can push to
 * — because the only thing worth proving here is that a repository becomes an image somewhere real.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const KUBE_SERVER = process.env.KUBE_SERVER
const BUILD_REGISTRY = process.env.BUILD_REGISTRY
const cluster = await (async () => {
  if (KUBE_SERVER === undefined || BUILD_REGISTRY === undefined) return false
  try {
    return (await fetch(`${KUBE_SERVER}/version`)).ok
  } catch {
    return false
  }
})()

const created: {
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []

async function seed(
  options: { owner?: string; repo?: string; sha?: string; imageUri?: string | null } = {},
) {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const tail = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `bld-${tail}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `bld-${tail}`, name: "Build", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${tail}`),
      ownerLogin: options.owner ?? "crccheck",
      name: options.repo ?? "docker-hello-world",
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
      name: "Hello",
      slug: `h${tail.slice(0, 8)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      gitSha: options.sha ?? "master",
      status: "queued",
      imageUri: options.imageUri ?? null,
    })
    .execute()
  created.push({ table: "deployment", id: deploymentId })

  return { deploymentId, orgId, projectId }
}

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }

function jobFor(deploymentId: string): Job {
  return {
    id: v7(),
    kind: "deploy.build",
    payload: { deploymentId },
    attempt: 1,
    maxAttempts: 1,
    organizationId: null,
  }
}

async function rowFor(id: string) {
  return await db
    .selectFrom("deployment")
    .select(["status", "imageUri"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

afterAll(async () => {
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe("buildSettingsFromEnv", () => {
  it("refuses to guess where images go", () => {
    // A default here would be a build that succeeds and pushes somewhere nobody looks — which is
    // not a failure anyone notices quickly.
    const saved = process.env.BUILD_REGISTRY
    delete process.env.BUILD_REGISTRY

    expect(() => buildSettingsFromEnv()).toThrow(/BUILD_REGISTRY/)

    if (saved !== undefined) process.env.BUILD_REGISTRY = saved
  })
})

describe.skipIf(!reachable)("buildImage", () => {
  it("does not rebuild an image that already exists", async () => {
    // A retried job must not pay for the same build twice. The unreachable server is the assertion:
    // creating a Job at all would throw.
    const { deploymentId } = await seed({ imageUri: "registry.test/acme/app:abc" })

    await buildImage({ server: "http://127.0.0.1:1" }, { registry: "registry.test" })(
      jobFor(deploymentId),
      context,
    )

    // Handed straight on to the revision instead.
    const queued = await db
      .selectFrom("backgroundJob")
      .select("id")
      .where("idempotencyKey", "=", `deploy.revision:${deploymentId}`)
      .execute()

    expect(queued).toHaveLength(1)
  })

  it("does nothing to a torn-down deployment", async () => {
    const { deploymentId } = await seed()
    await db
      .updateTable("deployment")
      .set({ status: "torn_down" })
      .where("id", "=", deploymentId)
      .execute()

    await buildImage({ server: "http://127.0.0.1:1" }, { registry: "registry.test" })(
      jobFor(deploymentId),
      context,
    )

    expect((await rowFor(deploymentId)).status).toBe("torn_down")
  })
})

describe.skipIf(!reachable || !cluster)("buildImage against a real cluster", () => {
  it("turns a git repository into an image and records where it went", async () => {
    const { deploymentId } = await seed()
    const settings = {
      registry: BUILD_REGISTRY!,
      insecureRegistry: process.env.BUILD_REGISTRY_INSECURE === "true",
    }
    const handler = buildImage({ server: KUBE_SERVER! }, settings)

    await handler(jobFor(deploymentId), context)

    // A first build can outrun the handler's budget, in which case it re-enqueues. Running it again
    // is what the queue would do — and is the difference between requiring a built image and
    // accepting "well, it was still going".
    if ((await rowFor(deploymentId)).imageUri === null) {
      await handler(jobFor(deploymentId), context)
    }

    const row = await rowFor(deploymentId)
    expect(row.imageUri).toContain(settings.registry)
    // Tagged with the commit that was asked for, never a moving tag.
    expect(row.imageUri).toContain(":master")

    const build = await db
      .selectFrom("deploymentBuild")
      .select(["exitCode", "finishedAt"])
      .where("deploymentId", "=", deploymentId)
      .executeTakeFirstOrThrow()

    expect(build.exitCode).toBe(0)
    expect(build.finishedAt).not.toBeNull()
  }, 300_000)
})
