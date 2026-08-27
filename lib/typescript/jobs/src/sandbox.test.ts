import { crudSandbox } from "@lib/dao"
import { SandboxNotFoundError } from "@lib/sandbox"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import {
  meterSandboxes,
  PROVIDER_COST_MICRO_USD_PER_SECOND,
  provisionSandbox,
  reconcileSandboxes,
  reapSandboxes,
  requestSandboxDestroy,
  requestSandboxStart,
  SANDBOX_KINDS,
  SandboxDeletingError,
  startSandbox,
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
let otherUserId: string
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
  otherUserId = v7()
  organizationId = v7()
  repositoryId = v7()
  projectId = v7()

  await db
    .insertInto("user")
    .values([
      { id: userId, email: `mtr-${userId}@test.invalid`, name: "Meter Test" },
      { id: otherUserId, email: `mtr-${otherUserId}@test.invalid`, name: "Meter Test Other" },
    ])
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

beforeEach(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await sql`delete from metering_outbox where payload ->> 'organization_id' = ${organizationId}`.execute(
      tx,
    )
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
  })
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await sql`delete from metering_outbox where payload ->> 'organization_id' = ${organizationId}`.execute(
      tx,
    )
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "in", [userId, otherUserId]).execute()
  })
  await db.destroy()
})

async function eventsFor(sandboxId: string) {
  const result = await sql<{ payload: string }>`
    select payload::text as payload
    from metering_outbox
    where payload ->> 'resource_id' = ${sandboxId}
  `.execute(db)

  type SandboxEventPayload = {
    attributes: Record<string, string>
    charged_externally: boolean
    dimension: string
    event_id: string
    external_id: string
    organization_id: string
    project_id: string | null
    quantity: string
    resource_id: string | null
    resource_type: string
    source: string
    window_end: string | null
    window_start: string | null
  }

  return result.rows
    .map((row) => JSON.parse(row.payload) as SandboxEventPayload)
    .toSorted((a, b) => a.dimension.localeCompare(b.dimension))
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
    expect(events[0]).toMatchObject({
      attributes: {},
      charged_externally: false,
      organization_id: organizationId,
      project_id: projectId,
      resource_id: sandbox.id,
      resource_type: "sandbox",
      source: "sandbox",
    })
    expect(events[0]?.event_id).toMatch(/^[0-9a-f]{64}$/)
    expect(events[0]?.external_id).toContain(`${sandbox.id}:sandbox_cpu_second:`)
    expect(events[0]?.window_start).not.toBeNull()
    expect(events[0]?.window_end).not.toBeNull()

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

  it("serializes concurrent meters so their intervals never overlap", async ({ skip }) => {
    if (!reachable) skip()

    const initialWatermark = new Date(Date.now() - 60_000)
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      cpu: 1,
      memoryGib: 1,
      diskGib: 1,
      meteredThrough: initialWatermark,
    })

    let announceLocked: (() => void) | undefined
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve
    })
    let releaseLock: (() => void) | undefined
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve
    })

    // Hold the row while both sweeps reach it. Without the meter's own `FOR UPDATE`, both read the
    // old watermark, emit overlapping sixty-second intervals, then wait only when updating it.
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("sandbox")
        .select("id")
        .where("id", "=", sandbox.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      announceLocked?.()
      await release
    })
    await locked

    const first = meterSandboxes(job, context)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = meterSandboxes(job, context)
    await new Promise((resolve) => setTimeout(resolve, 100))
    releaseLock?.()
    await Promise.all([blocker, first, second])

    const cpuEvents = (await eventsFor(sandbox.id))
      .filter((row) => row.dimension === "sandbox_cpu_second")
      .toSorted((a, b) => (a.window_start ?? "").localeCompare(b.window_start ?? ""))
    expect(cpuEvents.length).toBeGreaterThan(0)

    const totalCpu = cpuEvents.reduce((sum, row) => sum + Number(row.quantity), 0)
    const elapsed = (Date.now() - initialWatermark.getTime()) / 1000
    expect(totalCpu).toBeGreaterThan(59)
    expect(totalCpu).toBeLessThan(elapsed + 1)

    for (let index = 1; index < cpuEvents.length; index += 1) {
      expect(cpuEvents[index]?.window_start).toBe(cpuEvents[index - 1]?.window_end)
    }
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

  it("never bills an ordinary sandbox past its provider auto-stop deadline", async ({ skip }) => {
    if (!reachable) skip()

    const activity = new Date(Date.now() - 60_000)
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      state: "running",
      cpu: 1,
      memoryGib: 1,
      diskGib: 1,
      idleTimeoutS: 10,
      lastActivityAt: activity,
      meteredThrough: activity,
    })

    await meterSandboxes(job, context)
    const cpu = (await eventsFor(sandbox.id)).find((row) => row.dimension === "sandbox_cpu_second")
    expect(Number(cpu?.quantity)).toBeGreaterThan(9)
    expect(Number(cpu?.quantity)).toBeLessThan(11)
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

    /*
      Aged deliberately, rather than relying on the time this test takes to reach the next line.

      `meterSandboxes` skips a row whose billable interval is not positive, and the interval for a
      brand-new sandbox is however long elapses between these two statements. That is not a
      quantity any assertion should depend on: it is short enough to round away, and `meterSandboxes`
      is a *global* sweep, so another test file running in parallel can bill this sandbox first and
      advance `metered_through` to the moment it ran. Either way this call finds nothing to bill and
      the event never appears — observed as a failure in two runs out of three of the directory, and
      a pass every time the file ran alone.

      Ten seconds of real age makes the interval a fact about the row instead of a fact about the
      scheduler. Written through the database's clock for the reason the handler documents: these
      are two containers in CI and the skew between them is real.
    */
    await sql`update sandbox set created_at = now() - interval '10 seconds' where id = ${sandbox.id}`.execute(
      db,
    )

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
      userId: otherUserId,
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

  it("retries provider cleanup for a failed sandbox with an external id", async ({ skip }) => {
    if (!reachable) skip()
    const failed = await crudSandbox(db).create({
      projectId,
      userId,
      state: "failed",
      externalId: `failed-provider-${v7()}`,
    })

    await reapSandboxes(job, context)

    const queued = await db
      .selectFrom("backgroundJob")
      .select("payload")
      .where("kind", "=", SANDBOX_KINDS.stop)
      .execute()
    expect(queued.map((row) => row.payload)).toContainEqual({ sandboxId: failed.id })
  })
})

describe("reconcileSandboxes", () => {
  it("repairs a provider auto-archive that the database did not observe", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: "daytona-archived-test",
      provider: "daytona",
      state: "running",
      meteredThrough: new Date(),
    })

    await reconcileSandboxes(
      () =>
        ({
          state: (externalId: string) =>
            Promise.resolve(externalId === sandbox.externalId ? "archived" : "started"),
        }) as never,
    )({ id: v7(), kind: SANDBOX_KINDS.reconcile, payload: {} } as never, context)

    const row = await db
      .selectFrom("sandbox")
      .select("state")
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("stopped")
  })
})

describe("startSandbox", () => {
  it("starts the provider and begins a fresh metering interval", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: "daytona-start-test",
      provider: "daytona",
      state: "starting",
      meteredThrough: new Date(Date.now() - 60_000),
    })
    const started: string[] = []

    await startSandbox(
      () =>
        ({
          start: (externalId: string) => {
            started.push(externalId)
            return Promise.resolve()
          },
        }) as never,
    )(
      {
        id: v7(),
        kind: SANDBOX_KINDS.start,
        organizationId,
        payload: { sandboxId: sandbox.id },
      } as never,
      context,
    )

    expect(started).toEqual(["daytona-start-test"])
    const row = await db
      .selectFrom("sandbox")
      .select(["state", "meteredThrough"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("running")
    expect(row.meteredThrough?.getTime()).toBeGreaterThan(Date.now() - 10_000)
  })

  it("cannot let a failed concurrent start overwrite a successful one", async ({ skip }) => {
    if (!reachable) skip()

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: `daytona-concurrent-start-${v7()}`,
      provider: "daytona",
      state: "starting",
    })
    let releaseFailure: (() => void) | undefined
    const successful = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    let calls = 0
    const handler = startSandbox(
      () =>
        ({
          start: async () => {
            calls += 1
            if (calls === 1) {
              await successful
              throw new Error("the losing provider call failed")
            }
            releaseFailure?.()
          },
        }) as never,
    )
    const makeJob = () =>
      ({ id: v7(), kind: SANDBOX_KINDS.start, payload: { sandboxId: sandbox.id } }) as never

    const outcomes = await Promise.allSettled([
      handler(makeJob(), context),
      handler(makeJob(), context),
    ])
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true)
    expect(calls).toBe(2)

    const row = await db
      .selectFrom("sandbox")
      .select("state")
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("running")
  })

  it("reprovisions when a stopped row points at a provider object that no longer exists", async ({
    skip,
  }) => {
    if (!reachable) skip()

    const missingExternalId = `daytona-missing-${v7()}`
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: missingExternalId,
      provider: "daytona",
      state: "starting",
    })

    await startSandbox(
      () =>
        ({
          start: () => Promise.reject(new SandboxNotFoundError(missingExternalId)),
        }) as never,
    )(
      {
        id: v7(),
        kind: SANDBOX_KINDS.start,
        organizationId,
        payload: { sandboxId: sandbox.id },
      } as never,
      context,
    )

    const row = await db
      .selectFrom("sandbox")
      .select(["state", "externalId"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ state: "starting", externalId: null })

    const jobs = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload", "idempotencyKey"])
      .where("organizationId", "=", organizationId)
      .execute()
    expect(jobs).toContainEqual({
      kind: SANDBOX_KINDS.provision,
      payload: { sandboxId: sandbox.id },
      idempotencyKey: `${SANDBOX_KINDS.provision}:${sandbox.id}:missing:${missingExternalId}`,
    })
  })
})

describe("sandbox lifecycle requests", () => {
  it("creates one row and one provision job under concurrent first starts", async ({ skip }) => {
    if (!reachable) skip()

    const starts = await Promise.all(
      Array.from({ length: 8 }, () =>
        requestSandboxStart(db, {
          organizationId,
          projectId,
          userId,
          idleTimeoutS: 900,
        }),
      ),
    )

    expect(new Set(starts.map((row) => row.id)).size).toBe(1)
    const rows = await db
      .selectFrom("sandbox")
      .select("id")
      .where("projectId", "=", projectId)
      .where("userId", "=", userId)
      .execute()
    expect(rows).toHaveLength(1)
    const jobs = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload"])
      .where("organizationId", "=", organizationId)
      .where("kind", "=", SANDBOX_KINDS.provision)
      .execute()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.payload).toEqual({ sandboxId: rows[0]?.id })
  })

  it("marks deletion and enqueues it atomically, then refuses a restart", async ({ skip }) => {
    if (!reachable) skip()
    const sandbox = await crudSandbox(db).create({ projectId, userId, state: "running" })

    const deleting = await requestSandboxDestroy(db, { organizationId, projectId, userId })
    expect(deleting?.state).toBe("deleting")
    await expect(
      requestSandboxStart(db, { organizationId, projectId, userId, idleTimeoutS: 900 }),
    ).rejects.toBeInstanceOf(SandboxDeletingError)

    const destroyJob = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload", "idempotencyKey"])
      .where("organizationId", "=", organizationId)
      .executeTakeFirstOrThrow()
    expect(destroyJob).toMatchObject({
      kind: SANDBOX_KINDS.destroy,
      payload: { sandboxId: sandbox.id },
      idempotencyKey: `${SANDBOX_KINDS.destroy}:${sandbox.id}`,
    })
  })
})

describe("provisionSandbox", () => {
  it("restores proxy authorization before retrying a failed bootstrap", async ({ skip }) => {
    if (!reachable) skip()
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: `daytona-failed-retry-${v7()}`,
      state: "failed",
    })
    let stateSeenByProvider: string | undefined

    await expect(
      provisionSandbox(
        () =>
          ({
            state: async () => {
              stateSeenByProvider = (
                await db
                  .selectFrom("sandbox")
                  .select("state")
                  .where("id", "=", sandbox.id)
                  .executeTakeFirstOrThrow()
              ).state
              throw new Error("provider probe complete")
            },
            stop: () => Promise.resolve(),
          }) as never,
      )(
        {
          id: v7(),
          kind: SANDBOX_KINDS.provision,
          organizationId,
          payload: { sandboxId: sandbox.id },
        } as never,
        context,
      ),
    ).rejects.toThrow("provider probe complete")

    expect(stateSeenByProvider).toBe("starting")
    expect(
      (
        await db
          .selectFrom("sandbox")
          .select("state")
          .where("id", "=", sandbox.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("failed")
  })

  it("reprovisions when a failed retry points at a provider object that no longer exists", async ({
    skip,
  }) => {
    if (!reachable) skip()
    const missingExternalId = `daytona-provision-missing-${v7()}`
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: missingExternalId,
      state: "starting",
    })

    await provisionSandbox(
      () =>
        ({
          state: () => Promise.reject(new SandboxNotFoundError(missingExternalId)),
        }) as never,
    )(
      {
        id: v7(),
        kind: SANDBOX_KINDS.provision,
        organizationId,
        payload: { sandboxId: sandbox.id },
      } as never,
      context,
    )

    const row = await db
      .selectFrom("sandbox")
      .select(["state", "externalId"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ state: "starting", externalId: null })

    const replacement = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload", "idempotencyKey"])
      .where("organizationId", "=", organizationId)
      .executeTakeFirstOrThrow()
    expect(replacement).toEqual({
      kind: SANDBOX_KINDS.provision,
      payload: { sandboxId: sandbox.id },
      idempotencyKey: `${SANDBOX_KINDS.provision}:${sandbox.id}:missing:${missingExternalId}`,
    })
  })

  it("marks an external-id retry failed when driver configuration cannot be built", async ({
    skip,
  }) => {
    if (!reachable) skip()
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: `daytona-bootstrap-retry-${v7()}`,
      state: "starting",
    })

    await expect(
      provisionSandbox(() => {
        throw new Error("driver configuration is unavailable")
      })(
        { id: v7(), kind: SANDBOX_KINDS.provision, payload: { sandboxId: sandbox.id } } as never,
        context,
      ),
    ).rejects.toThrow("driver configuration is unavailable")

    const row = await db
      .selectFrom("sandbox")
      .select("state")
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("failed")
  })

  it("treats bootstrap problems as job failures", async ({ skip }) => {
    if (!reachable) skip()
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: `daytona-bootstrap-problem-${v7()}`,
      state: "starting",
    })

    const stopped: string[] = []
    await expect(
      provisionSandbox(
        () =>
          ({
            state: () => Promise.resolve("started"),
            stop: (externalId: string) => {
              stopped.push(externalId)
              return Promise.resolve()
            },
          }) as never,
      )(
        { id: v7(), kind: SANDBOX_KINDS.provision, payload: { sandboxId: sandbox.id } } as never,
        context,
      ),
    ).rejects.toThrow(/could not be bootstrapped/)
    expect(stopped).toEqual([sandbox.externalId])

    const row = await db
      .selectFrom("sandbox")
      .select("state")
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("failed")
  })
})
