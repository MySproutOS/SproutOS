import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { JOB_KINDS, scheduleRecurring } from "./handlers"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const TEST_YEAR = "2099"

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("backgroundJob").where("idempotencyKey", "like", `%:${TEST_YEAR}-%`).execute()
  await db.destroy()
})

describe.skipIf(!reachable)("metering schedules", () => {
  it("schedules one relay per minute and one import per ten-minute window", async ({ skip }) => {
    if (!reachable) skip()
    const now = new Date(`${TEST_YEAR}-12-31T23:58:45.000Z`)
    const relayKey = `${JOB_KINDS.relayMeteringOutbox}:${now.toISOString().slice(0, 16)}`
    const importKey = `${JOB_KINDS.importUsage}:${now.toISOString().slice(0, 15)}`

    // Calling the scheduler repeatedly is how every worker uses it. The idempotency key, not a
    // process-local timer, is what makes one job per window.
    await scheduleRecurring(db, now)
    await scheduleRecurring(db, now)

    const scheduled = await db
      .selectFrom("backgroundJob")
      .select(["kind", "idempotencyKey"])
      .where("idempotencyKey", "in", [relayKey, importKey])
      .orderBy("kind")
      .execute()

    expect(scheduled).toEqual([
      { kind: JOB_KINDS.importUsage, idempotencyKey: importKey },
      { kind: JOB_KINDS.relayMeteringOutbox, idempotencyKey: relayKey },
    ])
  })
})
