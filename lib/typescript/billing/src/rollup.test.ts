import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { LATE_ARRIVAL_GRACE_MS, rollUpUsage } from "./rollup"

/**
 * Against the docker-compose Postgres, not a mock.
 *
 * Every property worth asserting here is a database property: `for update skip locked`, the
 * `nulls not distinct` unique index, and the fact that `rated_at` lands in the same transaction as
 * the upsert. A fake would assert that the TypeScript calls the functions it calls.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let projectId: string
let repositoryId: string

/** Far enough in the past to be outside the grace window without depending on how long the test
 *  takes to run. */
const CLOSED = new Date(Date.now() - LATE_ARRIVAL_GRACE_MS - 60_000)

let seq = 0
async function event(quantity: string, project: string | null, at: Date = CLOSED): Promise<string> {
  const id = v7()
  seq += 1
  await db
    .insertInto("usageEvent")
    .values({
      id,
      organizationId,
      projectId: project,
      resourceType: "site",
      dimension: "site_vcpu_second",
      quantity,
      occurredAt: at,
      source: "metering-agent",
      externalId: `rollup-test-${id}-${seq}`,
    })
    .execute()
  return id
}

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

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `rollup-${ownerUserId}@test.invalid`, name: "Rollup Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Rollup Test Org",
      slug: `rollup-test-${organizationId.slice(0, 8)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  // `project.repository_id` is NOT NULL — a project on this platform is always a repository the
  // customer owns, so the fixture needs one even though nothing here reads it.
  repositoryId = v7()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Date.now() % 1_000_000_000,
      ownerLogin: "rollup-test",
      name: `repo-${repositoryId.slice(0, 8)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Rollup Test Project",
      slug: "rollup-test",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return

  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("usageRollup").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("usageEvent").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })

  await db.destroy()
})

/** Total quantity in one bucket grain, as a number. Safe here: the test quantities are small. */
async function rolled(bucket: string, project: string | null): Promise<number> {
  const rows = await db
    .selectFrom("usageRollup")
    .select(sql<string>`coalesce(sum(quantity), 0)::text`.as("total"))
    .where("organizationId", "=", organizationId)
    .where("bucket", "=", bucket)
    .where(project === null ? "projectId" : "projectId", project === null ? "is" : "=", project)
    .execute()
  return Number(rows[0]?.total ?? "0")
}

describe("rollUpUsage", () => {
  /*
    Drained first, then asserted.

    The development database is shared and accumulates unrated events from whatever else has been
    run against it, so `expect(events).toBe(0)` on a cold run asserts that nobody used the machine.
    The property worth testing is that the job *converges*: run it until it reports nothing, and the
    next run must also report nothing.
  */
  it("does nothing once there is nothing closed and unrated left", async ({ skip }) => {
    if (!reachable) skip()
    while ((await rollUpUsage(db)).events > 0) {
      // drain
    }
    const result = await rollUpUsage(db)
    expect(result.events).toBe(0)
    expect(result.rollups).toBe(0)
  })

  it("folds an event into all three grains and marks it rated", async ({ skip }) => {
    if (!reachable) skip()
    const id = await event("1.500000000", projectId)

    const result = await rollUpUsage(db)
    expect(result.events).toBeGreaterThanOrEqual(1)

    expect(await rolled("minute", projectId)).toBeCloseTo(1.5, 6)
    expect(await rolled("hour", projectId)).toBeCloseTo(1.5, 6)
    expect(await rolled("day", projectId)).toBeCloseTo(1.5, 6)

    const row = await db
      .selectFrom("usageEvent")
      .select("ratedAt")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(row.ratedAt).not.toBeNull()
  })

  /*
    The property the whole design turns on.

    `rated_at` is set inside the same transaction as the upsert, so a second run must find nothing.
    If it were set afterwards — or not at all — the job runner's ordinary retry would add the same
    quantity again, and the customer's bill would grow by one batch on every retry with no error
    anywhere to notice.
  */
  it("is exactly-once: a second run adds nothing", async ({ skip }) => {
    if (!reachable) skip()
    await event("2.000000000", projectId)
    await rollUpUsage(db)
    const after = await rolled("day", projectId)

    const second = await rollUpUsage(db)
    expect(second.events).toBe(0)
    expect(await rolled("day", projectId)).toBeCloseTo(after, 6)
  })

  it("adds to an existing grain rather than creating a second row", async ({ skip }) => {
    if (!reachable) skip()
    const before = await rolled("day", projectId)
    await event("0.250000000", projectId)
    await rollUpUsage(db)
    const between = await rolled("day", projectId)
    expect(between).toBeCloseTo(before + 0.25, 6)

    await event("0.250000000", projectId)
    await rollUpUsage(db)
    expect(await rolled("day", projectId)).toBeCloseTo(before + 0.5, 6)

    // One row per grain, not one per run. The unique index is what makes the addition above an
    // addition rather than a second row the monthly sum would happen to add anyway — which would
    // look identical here and diverge the moment anything counted rows.
    const rows = await db
      .selectFrom("usageRollup")
      .select(db.fn.countAll<string>().as("n"))
      .where("organizationId", "=", organizationId)
      .where("bucket", "=", "day")
      .where("projectId", "=", projectId)
      .executeTakeFirstOrThrow()
    expect(Number(rows.n)).toBe(1)
  })

  /*
    A standalone backend service belongs to an organization and to no project (TASK 37), so its
    `project_id` is null. Under a default `nulls distinct` unique index every run would insert a new
    row for the same grain instead of adding to it, and the duplicates would inflate the monthly
    sum rather than being ignored. `usage_rollup_grain_key` is declared `nulls not distinct`; this
    is the assertion that says so.
  */
  it("groups project-less usage into one grain, not one row per run", async ({ skip }) => {
    if (!reachable) skip()
    await event("3.000000000", null)
    await rollUpUsage(db)
    await event("4.000000000", null)
    await rollUpUsage(db)

    expect(await rolled("day", null)).toBeCloseTo(7, 6)

    const rows = await db
      .selectFrom("usageRollup")
      .select(db.fn.countAll<string>().as("n"))
      .where("organizationId", "=", organizationId)
      .where("bucket", "=", "day")
      .where("projectId", "is", null)
      .executeTakeFirstOrThrow()
    expect(Number(rows.n)).toBe(1)
  })

  /*
    An event inside the grace window is left alone.

    The agent buffers and retries, so events arrive late. Rolling a bucket up the instant its window
    closes would miss them permanently — `rated_at` is set in the same transaction, so a skipped
    event is never selected again and its usage is simply never billed.
  */
  it("leaves an event inside the late-arrival grace window unrated", async ({ skip }) => {
    if (!reachable) skip()
    const id = await event("9.000000000", projectId, new Date())

    await rollUpUsage(db)

    const row = await db
      .selectFrom("usageEvent")
      .select("ratedAt")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(row.ratedAt).toBeNull()
  })
})
