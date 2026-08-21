// Imported for its side effect: `@sproutos/db` loads `.env`, and every other suite in this package
// gets its configuration that way by touching the database. This one does not touch the database at
// all — so without this it read an empty environment, skipped silently, and reported four more
// "skipped" in a run nobody reads twice. That is the failure mode this repository keeps writing
// findings about.
import "@sproutos/db"
import { afterAll, describe, expect, it } from "vitest"
import { isNeonId, neonConfigFromEnv, neonId, neonStorage } from "./neon"

/**
 * Self-hosted Neon's storage layer, against the real thing.
 *
 * `docker compose up -d neon-broker neon-controller neon-safekeeper neon-pageserver` brings it up.
 * The suite skips without it and says so rather than passing quietly.
 *
 * The assertion that matters is the branch: a timeline with an ancestor, holding no pages of its
 * own. Three backlog items were `[~]` because the platform could not do that — it provisioned a
 * database and a role on an ordinary cluster, where "branching" would mean copying the data.
 */
const config = (() => {
  try {
    return neonConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config === undefined) return false
  try {
    const response = await fetch(`${config.controllerUrl}/control/v1/node`)
    return response.ok
  } catch {
    return false
  }
})()

const tenants: string[] = []

afterAll(async () => {
  if (!reachable) return
  const storage = neonStorage(config!)
  // A leaked tenant is not free: the pageserver keeps its layers and the controller keeps
  // heartbeating about it.
  for (const tenantId of tenants) await storage.deleteTenant(tenantId).catch(() => undefined)
}, 120_000)

describe("neon ids", () => {
  it("are 32 lowercase hex characters, not UUIDs", () => {
    // Neon's own format. Deriving one from a SproutOS uuid would look tidy and would be a control
    // plane that assumes it minted every id it sees — it does not, once a shard split happens.
    expect(isNeonId(neonId())).toBe(true)
    expect(isNeonId("01a01e12-1700-76ac-9713-dd208babdf5a")).toBe(false)
  })

  it("do not repeat", () => {
    expect(new Set(Array.from({ length: 64 }, () => neonId())).size).toBe(64)
  })
})

describe("neonConfigFromEnv", () => {
  it("refuses to guess a controller address", () => {
    // Every tenant operation goes through it, and a wrong one would mean creating tenants somewhere
    // nobody is looking.
    expect(() => neonConfigFromEnv({})).toThrow(/NEON_CONTROLLER_URL/)
  })
})

describe.runIf(reachable)("the storage layer", () => {
  it("creates a tenant and its root timeline", async () => {
    const storage = neonStorage(config!)

    const tenantId = await storage.createTenant()
    tenants.push(tenantId)
    const timeline = await storage.createTimeline(tenantId)

    expect(timeline.tenant_id).toBe(tenantId)
    expect(isNeonId(timeline.timeline_id)).toBe(true)
    // A root timeline has no ancestor. The branch below is told apart by exactly this.
    expect(timeline.ancestor_timeline_id ?? null).toBeNull()
  }, 180_000)

  it("branches copy-on-write, copying nothing", async () => {
    /*
      The property three backlog items were waiting on.

      A branch shares every page its parent had at the branch LSN and stores only what changes
      afterwards, so `current_physical_size` is 0 at creation however large the parent is. On the
      `sprout` provider this operation did not exist, and the nearest thing — copying a database —
      is linear in its size.
    */
    const storage = neonStorage(config!)

    const tenantId = await storage.createTenant()
    tenants.push(tenantId)
    const parent = await storage.createTimeline(tenantId)
    const branch = await storage.branchTimeline(tenantId, parent.timeline_id)

    expect(branch.ancestor_timeline_id).toBe(parent.timeline_id)
    expect(branch.timeline_id).not.toBe(parent.timeline_id)
    expect(branch.current_physical_size).toBe(0)
    // Branched from where the parent was, which is what a customer asking for a branch means.
    expect(branch.ancestor_lsn).toBeTruthy()
  }, 180_000)

  it("tells the control plane which pageserver holds the tenant", async () => {
    /*
      Not a nicety: the storage controller panics without somewhere to send this, *after* creating
      and attaching the tenant, and the reconcile never completes. Self-hosting Neon means
      implementing the compute hook first.

      Asserted through the controller rather than the database so this suite needs no schema.
    */
    const storage = neonStorage(config!)
    const tenantId = await storage.createTenant()
    tenants.push(tenantId)

    const response = await fetch(`${config!.controllerUrl}/control/v1/tenant/${tenantId}`)
    expect(response.ok).toBe(true)
  }, 180_000)

  it("deletes a timeline without taking its parent", async () => {
    // Teardown of a preview branch must not touch production's.
    const storage = neonStorage(config!)

    const tenantId = await storage.createTenant()
    tenants.push(tenantId)
    const parent = await storage.createTimeline(tenantId)
    const branch = await storage.branchTimeline(tenantId, parent.timeline_id)

    await storage.deleteTimeline(tenantId, branch.timeline_id)

    const response = await fetch(
      `${config!.controllerUrl}/v1/tenant/${tenantId}/timeline/${parent.timeline_id}`,
    )
    expect(response.ok).toBe(true)
  }, 180_000)
})
