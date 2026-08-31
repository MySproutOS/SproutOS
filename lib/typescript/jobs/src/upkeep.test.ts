import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { scheduleUpkeepScan, UPKEEP_KINDS } from "./upkeep"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const PREFIX = `${UPKEEP_KINDS.scan}:2098-`

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("backgroundJob").where("idempotencyKey", "like", `${PREFIX}%`).execute()
  await db.destroy()
})

describe.skipIf(!reachable)("upkeep scheduling", () => {
  it("enqueues one scan per UTC hour and catches the next window after downtime", async ({
    skip,
  }) => {
    if (!reachable) skip()
    const first = new Date("2098-04-01T00:02:00.000Z")
    const caughtUp = new Date("2098-04-08T15:00:00.000Z")

    await scheduleUpkeepScan(db, first)
    await scheduleUpkeepScan(db, first)
    await scheduleUpkeepScan(db, caughtUp)

    const rows = await db
      .selectFrom("backgroundJob")
      .select("idempotencyKey")
      .where("idempotencyKey", "like", `${PREFIX}%`)
      .orderBy("idempotencyKey")
      .execute()

    expect(rows).toEqual([
      { idempotencyKey: `${UPKEEP_KINDS.scan}:2098-04-01T00` },
      { idempotencyKey: `${UPKEEP_KINDS.scan}:2098-04-08T15` },
    ])
  })
})
