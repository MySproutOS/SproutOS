import { crudSandbox } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import {
  meterSandboxes,
  PROVIDER_COST_MICRO_USD_PER_SECOND,
  reapSandboxes,
  SANDBOX_KINDS,
} from "./sandbox"

/**
 * Against a real Postgres, because every property here is about rows.
 *
 * The meter's correctness is a transaction, a conflict clause and an interval comparison; the
 * margin check is a join against the price book. None of that is observable anywhere else.
 */
let reachable = false
let organizationId: string
let userId: string
let repositoryId: string
let projectId: string

const job = { id: v7(), kind: SANDBOX_KINDS.meter, payload: {} } as never
const context = { db } as never

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  userId = v7()
  organizationId = v7()
  repositoryId = v7()
  projectId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `mtr-${userId}@test.invalid`, name: "Meter Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Meter Test Org",
      slug: `mtr-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "mtr-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({ id: projectId, organizationId, repositoryId, name: "Meter", slug: "mtr-test" })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("usageEvent").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
  await db.destroy()
})

async function eventsFor(sandboxId: string) {
  return await db
    .selectFrom("usageEvent")
    .select(["dimension", "quantity", "externalId"])
    .where("resourceId", "=", sandboxId)
    .orderBy("dimension")
    .execute()
}

describe("the sandbox price book", () => {
  /*
    The property with no error state.

    A dimension priced below what the provider charges us is a sandbox sold at a loss, and nothing
    anywhere fails: usage meters, statements reconcile, the dashboard is correct, and the only
    symptom is on an invoice arriving from the other direction. `docs/findings/0011-the-platform-was-free.md`
    is this failure one step earlier, when the rate was absent rather than merely too low.
  */
  it("never prices a dimension below what the provider charges us", async ({ skip }) => {
    if (!reachable) skip()

    const rates = await db
      .selectFrom("priceBookItem")
      .select(["dimension", "unitMicroUsd"])
      .where("dimension", "like", "sandbox%")
      .execute()

    const byDimension = new Map(rates.map((row) => [row.dimension, Number(row.unitMicroUsd)]))

    expect(byDimension.get("sandbox_cpu_second")).toBeGreaterThan(
      PROVIDER_COST_MICRO_USD_PER_SECOND.cpu,
    )
    expect(byDimension.get("sandbox_gib_second")).toBeGreaterThan(
      PROVIDER_COST_MICRO_USD_PER_SECOND.memoryGib,
    )
    expect(byDimension.get("sandbox_disk_gib_second")).toBeGreaterThan(
      PROVIDER_COST_MICRO_USD_PER_SECOND.diskGib,
    )
  })

  it("has a rate for every dimension the meter emits", async ({ skip }) => {
    if (!reachable) skip()
    // A dimension that meters and never rates produces usage a customer can see and is never
    // charged for — which looks like generosity and is actually an unpriced line.
    const rates = await db
      .selectFrom("priceBookItem")
      .select("dimension")
      .where("dimension", "like", "sandbox%")
      .execute()

    expect(rates.map((row) => row.dimension).sort()).toEqual([
      "sandbox_cpu_second",
      "sandbox_disk_gib_second",
      "sandbox_gib_second",
    ])
  })
})

describe("meterSandboxes", () => {
  it("bills cpu, memory and disk for the interval since the watermark", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      cpu: 2,
      memoryGib: 4,
      diskGib: 10,
      meteredThrough: new Date(Date.now() - 60_000),
    })

    await meterSandboxes(job, context)

    const events = await eventsFor(sandbox.id)
    expect(events.map((row) => row.dimension)).toEqual([
      "sandbox_cpu_second",
      "sandbox_disk_gib_second",
      "sandbox_gib_second",
    ])

    // ~60 seconds × the resource shape. Loose bounds: the interval is real wall-clock.
    const byDimension = new Map(events.map((row) => [row.dimension, Number(row.quantity)]))
    expect(byDimension.get("sandbox_cpu_second")).toBeGreaterThan(100)
    expect(byDimension.get("sandbox_cpu_second")).toBeLessThan(140)
    expect(byDimension.get("sandbox_gib_second")).toBeGreaterThan(200)
    expect(byDimension.get("sandbox_disk_gib_second")).toBeGreaterThan(500)
  })

  it("advances the watermark so the same second is never billed twice", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      cpu: 1,
      memoryGib: 1,
      diskGib: 1,
      meteredThrough: new Date(Date.now() - 60_000),
    })

    const startedAt = Date.now()
    await meterSandboxes(job, context)
    await meterSandboxes(job, context)
    const elapsed = (Date.now() - startedAt) / 1000

    /*
      Two runs may well produce two rows — the milliseconds between them are real seconds a real
      sandbox was running, and billing them is right. What must never happen is the same second
      appearing in both, so the property is about the *total*, not the row count: everything billed
      has to add up to the interval from the watermark to now, and no more.

      Asserting a row count instead would pass just as happily on a meter that billed the whole
      minute twice.
    */
    const totalCpu = (await eventsFor(sandbox.id))
      .filter((row) => row.dimension === "sandbox_cpu_second")
      .reduce((sum, row) => sum + Number(row.quantity), 0)

    expect(totalCpu).toBeGreaterThan(59)
    expect(totalCpu).toBeLessThan(61 + elapsed)
  })

  it("does not meter a stopped sandbox", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "stopped",
      meteredThrough: new Date(Date.now() - 60_000),
    })

    await meterSandboxes(job, context)
    expect(await eventsFor(sandbox.id)).toHaveLength(0)
  })

  /*
    Null is "never metered", and it has to mean `created_at` rather than the epoch. Metering from
    the epoch is roughly forty years of compute nobody ran, on the customer's bill, with every
    check passing.
  */
  it("bills a never-metered sandbox from its creation, not from the epoch", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      cpu: 1,
      memoryGib: 1,
      diskGib: 1,
      meteredThrough: null,
    })

    await meterSandboxes(job, context)

    const event = (await eventsFor(sandbox.id)).find(
      (row) => row.dimension === "sandbox_cpu_second",
    )

    /*
      Asserted separately, because `Number(undefined)` is `NaN` and every comparison against `NaN`
      is false. Folded into the bound below, a *missing* event failed as though the quantity were
      too large — which is what this test did on CI while passing locally, and it named a number
      rather than the absence.
    */
    expect(event, "no sandbox_cpu_second event was produced").toBeDefined()

    /*
      An hour, not a minute.

      The bug this guards against bills from the Unix epoch: roughly 1.8 *billion* seconds. Anything
      measured from creation is bounded by how long this test takes. Sixty seconds was a bound on
      the runner's speed rather than on the behaviour, and a loaded CI runner is exactly where it
      breaks — while still catching the real fault by six orders of magnitude at any threshold.
    */
    expect(Number(event?.quantity)).toBeLessThan(3600)
  })
})

describe("reapSandboxes", () => {
  it("enqueues a stop for an idle sandbox and leaves always-on alone", async ({ skip }) => {
    if (!reachable) skip()

    const idle = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      idleTimeoutS: 1,
      lastActivityAt: new Date(Date.now() - 10_000),
    })
    const alwaysOn = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      idleTimeoutS: 1,
      alwaysOn: true,
      lastActivityAt: new Date(Date.now() - 10_000),
    })

    await reapSandboxes(job, context)

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload"])
      .where("kind", "=", SANDBOX_KINDS.stop)
      .execute()

    const targets = queued.map((row) => (row.payload as { sandboxId?: string }).sandboxId)
    expect(targets).toContain(idle.id)
    expect(targets).not.toContain(alwaysOn.id)
  })
})
