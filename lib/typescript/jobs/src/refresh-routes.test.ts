import { readRoute } from "@lib/lambda"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { refreshRoutes } from "./refresh-routes"
import type { Job } from "./queue"

/**
 * The check that would have caught the outage.
 *
 * Every existing test deploys and immediately asserts the route is there, which is true and was
 * never the question — the route was written with a 24-hour TTL and nothing rewrote it, so what
 * needed asserting was that a route *comes back* once it is gone. This deletes the key by hand,
 * which is what expiry looks like from the router's side.
 */
const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    await valkey.connect()
    return true
  } catch {
    return false
  }
})()

const created: {
  table: "user" | "organization" | "repository" | "project" | "deployment"
  id: string
}[] = []
const hostnames: string[] = []

afterAll(async () => {
  if (!reachable) return
  for (const hostname of hostnames) await valkey.del(`route:${hostname}`)
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await valkey.quit()
})

async function seedLiveProject(): Promise<{ projectId: string; hostname: string }> {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const suffix = repoId.slice(-12)
  const hostname = `refresh-${suffix}.sproutos.test`

  await db
    .insertInto("user")
    .values({ id: userId, email: `ref-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `ref-${suffix}`, name: "Ref", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
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
      slug: `ref${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      gitSha: "f".repeat(40),
      status: "ready",
      hostname,
      lambdaVersion: "3",
    })
    .execute()
  created.push({ table: "deployment", id: deploymentId })

  await db
    .updateTable("project")
    .set({ liveDeploymentId: deploymentId })
    .where("id", "=", projectId)
    .execute()

  hostnames.push(hostname)
  return { projectId, hostname }
}

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }
const job = {
  id: v7(),
  kind: "platform.refresh_routes",
  organizationId: null,
  payload: {},
  attempt: 1,
} as unknown as Job

describe.skipIf(!reachable)("refreshRoutes", () => {
  it("republishes a route that has expired", async () => {
    const { projectId, hostname } = await seedLiveProject()

    // Expiry, from the router's point of view. It cannot tell this from a TTL running out.
    await valkey.del(`route:${hostname}`)
    expect(await readRoute(valkey, hostname)).toBeUndefined()

    await refreshRoutes({ valkey })(job, context)

    const route = await readRoute(valkey, hostname)
    expect(route).toBeDefined()
    expect(route?.projectId).toBe(projectId)
  })

  it("gives the route a fresh lease, so the next expiry is a day away again", async () => {
    const { hostname } = await seedLiveProject()

    // A key about to expire is the state this job exists to prevent reaching zero.
    await valkey.set(`route:${hostname}`, JSON.stringify({ arn: "x" }), "EX", 5)

    await refreshRoutes({ valkey })(job, context)

    const ttl = await valkey.ttl(`route:${hostname}`)
    expect(ttl).toBeGreaterThan(60 * 60)
  })

  it("does not publish a route for a project with no live deployment", async () => {
    const { hostname } = await seedLiveProject()
    await valkey.del(`route:${hostname}`)

    // A project whose live pointer is null is not serving, and republishing its old hostname would
    // resurrect a site that was deliberately taken down.
    await db
      .updateTable("project")
      .set({ liveDeploymentId: null })
      .where(
        "id",
        "=",
        (
          await db
            .selectFrom("deployment")
            .select("projectId")
            .where("hostname", "=", hostname)
            .executeTakeFirstOrThrow()
        ).projectId,
      )
      .execute()

    await refreshRoutes({ valkey })(job, context)

    expect(await readRoute(valkey, hostname)).toBeUndefined()
  })
})
