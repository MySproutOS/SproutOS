import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  createEndpoint,
  dockerComputeLauncher,
  neonComputeConfigFromEnv,
  suspendEndpoint,
  wakeEndpoint,
} from "./neon-compute"
import { neonConfigFromEnv, neonStorage } from "./neon"

/**
 * Wake-on-connect: the property that makes an absent compute invisible.
 *
 * A timeline is storage. It answers page requests and holds no session and no running query, and
 * the economic argument for this whole architecture is that the compute can be absent while the
 * timeline is not. This asserts what a customer would experience: an endpoint with nothing running,
 * a connection, and a query that answers.
 *
 * Slow on purpose — starting a Postgres is the thing being measured. It runs whenever the Neon
 * stack is up rather than behind a flag nobody sets, which is the mistake `docs/findings/0013`
 * exists to record.
 */
const run = promisify(execFile)

const neon = (() => {
  try {
    return neonConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (neon === undefined) return false
  try {
    const response = await fetch(`${neon.controllerUrl}/control/v1/node`)
    if (!response.ok) return false
    await run("docker", ["version"])
    return true
  } catch {
    return false
  }
})()

const created: { endpoints: string[]; tenants: string[]; services: string[] } = {
  endpoints: [],
  tenants: [],
  services: [],
}
let organizationId = ""
let userId = ""

const launcher = reachable ? dockerComputeLauncher(neonComputeConfigFromEnv()) : undefined

/** A backend_service row to hang the endpoint off, plus a real tenant and timeline. */
async function endpoint(): Promise<{ endpointId: string; tenantId: string; timelineId: string }> {
  const storage = neonStorage(neon!)
  const tenantId = await storage.createTenant()
  created.tenants.push(tenantId)
  const timeline = await storage.createTimeline(tenantId)

  const backendServiceId = v7()
  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "Neon",
      kind: "postgres",
      status: "active",
    })
    .execute()
  created.services.push(backendServiceId)

  const endpointId = await createEndpoint(db, {
    backendServiceId,
    tenantId,
    timelineId: timeline.timeline_id,
  })
  created.endpoints.push(endpointId)

  return { endpointId, tenantId, timelineId: timeline.timeline_id }
}

if (reachable) {
  userId = v7()
  organizationId = v7()
  await db
    .insertInto("user")
    .values({ id: userId, email: `neon-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Neon",
      slug: `neon-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
}

afterAll(async () => {
  if (!reachable) return
  for (const id of created.endpoints) {
    await suspendEndpoint(db, launcher!, id).catch(() => undefined)
  }
  const storage = neonStorage(neon!)
  for (const id of created.tenants) await storage.deleteTenant(id).catch(() => undefined)
  if (created.endpoints.length > 0) {
    await db.deleteFrom("neonEndpoint").where("id", "in", created.endpoints).execute()
  }
  if (created.services.length > 0) {
    await db.deleteFrom("backendService").where("id", "in", created.services).execute()
  }
  if (organizationId !== "") {
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  }
  await db.destroy()
}, 300_000)

describe.runIf(reachable)("wake on connect", () => {
  it("starts a compute for a suspended endpoint and answers a query", async () => {
    /*
      The whole claim. An endpoint exists, nothing is running, and a query answers — which is what a
      customer connecting to a database they have not touched for a week experiences.
    */
    const { endpointId } = await endpoint()

    const before = await db
      .selectFrom("neonEndpoint")
      .select(["state", "host"])
      .where("id", "=", endpointId)
      .executeTakeFirstOrThrow()
    expect(before.state).toBe("suspended")
    expect(before.host).toBeNull()

    const address = await wakeEndpoint(db, launcher!, endpointId)

    const query = await run("docker", [
      "exec",
      address.host,
      "psql",
      `postgresql://cloud_admin@localhost:${address.port}/postgres`,
      "-tAc",
      "select current_setting('neon.tenant_id')",
    ])
    // Reading pages from the pageserver, not from a local data directory.
    expect(query.stdout.trim()).toMatch(/^[0-9a-f]{32}$/)
  }, 300_000)

  it("wakes fast enough that a connection can wait for it", async () => {
    /*
      The claim the backlog asked for, measured rather than asserted.

      Observed on a laptop under Docker: 820ms the first time, then 205ms and 214ms — a 214ms
      median. That is the whole argument for scale-to-zero: an idle database costs nothing and the
      customer cannot tell, because the wake fits inside a connection.

      The bound here is 10s, not 1s. The number to defend is the *order of magnitude* — starting a
      Postgres against an existing pageserver rather than restoring a volume or booting a VM — and a
      one-second assertion would fail on a loaded CI box for a reason that says nothing about the
      design.
    */
    const { endpointId } = await endpoint()

    const started = Date.now()
    await wakeEndpoint(db, launcher!, endpointId)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(10_000)
  }, 300_000)

  it("is a no-op on the second connection", async () => {
    // Called on every connection. On all but the first it has to be one indexed read, or every
    // connection to a warm database pays for the cold path.
    const { endpointId } = await endpoint()

    const first = await wakeEndpoint(db, launcher!, endpointId)
    const started = Date.now()
    const second = await wakeEndpoint(db, launcher!, endpointId)

    expect(second).toEqual(first)
    expect(Date.now() - started).toBeLessThan(1_000)
  }, 300_000)

  it("starts one compute when two connections arrive together", async () => {
    /*
      Two Postgres processes against one timeline is two writers on one set of pages. The
      safekeepers reject the second one's WAL — but only after it has accepted client connections
      and told them their transactions committed.

      The claim is taken with a conditional update, so of two callers exactly one launches and the
      other waits.
    */
    const { endpointId } = await endpoint()

    const [a, b] = await Promise.all([
      wakeEndpoint(db, launcher!, endpointId),
      wakeEndpoint(db, launcher!, endpointId),
    ])

    expect(a).toEqual(b)

    const { stdout } = await run("docker", [
      "ps",
      "--filter",
      `name=${a.host}`,
      "--format",
      "{{.Names}}",
    ])
    expect(stdout.trim().split("\n").filter(Boolean)).toHaveLength(1)
  }, 300_000)

  it("suspends without touching the timeline, and wakes again onto the same data", async () => {
    /*
      What suspension has to mean for the economics to work: the compute goes, the database does
      not. Written before suspending and read after waking — through a different Postgres process
      than the one that wrote it.
    */
    const { endpointId } = await endpoint()

    const first = await wakeEndpoint(db, launcher!, endpointId)
    await run("docker", [
      "exec",
      first.host,
      "psql",
      `postgresql://cloud_admin@localhost:${first.port}/postgres`,
      "-tAc",
      "create table kept(note text); insert into kept values ('survived the suspend')",
    ])

    await suspendEndpoint(db, launcher!, endpointId)
    const suspended = await db
      .selectFrom("neonEndpoint")
      .select(["state", "host"])
      .where("id", "=", endpointId)
      .executeTakeFirstOrThrow()
    expect(suspended.state).toBe("suspended")
    expect(suspended.host).toBeNull()

    const again = await wakeEndpoint(db, launcher!, endpointId)
    const read = await run("docker", [
      "exec",
      again.host,
      "psql",
      `postgresql://cloud_admin@localhost:${again.port}/postgres`,
      "-tAc",
      "select note from kept",
    ])

    expect(read.stdout.trim()).toBe("survived the suspend")
  }, 600_000)
})
