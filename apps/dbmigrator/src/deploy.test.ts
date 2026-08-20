import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { deploy } from "./deploy"

/**
 * The lock, not the migrations.
 *
 * What has to be true is that a second migrator cannot run while a first one is in the middle of
 * applying a schema change. That is asserted by *being* the first one: the lock is taken on a
 * connection this test controls, and `deploy` is then required to fail rather than proceed.
 *
 * Racing two real migrators would not prove it. Process startup staggers them by more than a
 * migration takes, so the unlocked version passes such a test almost every time — which is exactly
 * how a missing lock survives review and shows up on a rollout at scale instead.
 */
const up = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

const LOCK_KEY = "8012026"

afterAll(async () => {
  await db.destroy()
})

describe.skipIf(!up)("migrating on deploy", () => {
  it("refuses to start while another process holds the lock", async () => {
    // A connection of our own, pinned, standing in for the pod that got there first.
    const holder = db.connection().execute(async (pinned) => {
      await sql`select pg_advisory_lock(${sql.lit(LOCK_KEY)}::bigint)`.execute(pinned)
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await sql`select pg_advisory_unlock(${sql.lit(LOCK_KEY)}::bigint)`.execute(pinned)
    })

    // Give the holder time to actually take it before racing it.
    await new Promise((resolve) => setTimeout(resolve, 250))

    /*
      `55P03` is `lock_not_available` — Postgres's answer when `lock_timeout` expires. The assertion
      is on the code rather than the message because the message is localised and the code is the
      contract.
    */
    await expect(deploy({ lockTimeout: "500ms" })).rejects.toMatchObject({ code: "55P03" })

    await holder
  })

  it("takes and releases the lock, so the next run is not blocked by the last", async () => {
    // Everything is already applied — the suite runs after `migrate:latest`. What is being checked
    // is that two sequential deploys both succeed, which they cannot if the first left the lock on
    // a pooled connection.
    await expect(deploy({ lockTimeout: "2s" })).resolves.toMatchObject({ applied: [] })
    await expect(deploy({ lockTimeout: "2s" })).resolves.toMatchObject({ applied: [] })

    // And nothing is still holding it.
    const held = await sql<{
      count: string
    }>`select count(*)::text as count from pg_locks where locktype = 'advisory' and objid = ${sql.lit(LOCK_KEY)}::bigint`.execute(
      db,
    )
    expect(held.rows[0]?.count).toBe("0")
  })
})
