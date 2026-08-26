import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"

let reachable = false
const userId = v7()
const organizationId = v7()
const eventId = v7()

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  await db
    .insertInto("user")
    .values({ id: userId, email: `usage-cutover-${userId}@test.invalid`, name: "Usage Cutover" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Usage Cutover",
      slug: `usage-cutover-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("usageEvent").where("id", "=", eventId).execute()
  await db.deleteFrom("organization").where("id", "=", organizationId).execute()
  await db.deleteFrom("user").where("id", "=", userId).execute()
  await db.destroy()
})

describe("the temporary usage-event cutover partition", () => {
  it("accepts an event beyond every partition created by the init migration", async ({ skip }) => {
    if (!reachable) skip()

    const occurredAt = new Date("2036-01-01T00:00:00.000Z")
    await db
      .insertInto("usageEvent")
      .values({
        id: eventId,
        organizationId,
        projectId: null,
        resourceType: "site",
        dimension: "site_request",
        quantity: "1",
        occurredAt,
        source: "cutover-test",
        externalId: eventId,
      })
      .execute()

    const stored = await sql<{ partition: string }>`
      select tableoid::regclass::text as partition
        from usage_event
       where id = ${eventId} and occurred_at = ${occurredAt}
    `.execute(db)

    expect(stored.rows[0]?.partition).toBe("usage_event_cutover_default")
  })
})
