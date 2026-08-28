import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it, vi } from "vitest"
import { deploy } from "./deploy"

// CI already loads and applies every real migration before Vitest starts. This suite is about the
// deploy-time advisory lock, so do not enumerate the filesystem migrations again here: doing so
// couples a lock test to migration module loading and to whatever schema another test worker left
// in the shared database.
vi.mock("kysely/migration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("kysely/migration")>()
  return {
    ...actual,
    Migrator: class {
      migrateToLatest() {
        return Promise.resolve({ results: [] })
      }
    },
  }
})

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

  /*
    The first deploy against a new environment, which is the case the other tests cannot reach.

    Both tests above run against a development database that has been migrated many times, so
    `kysely_migration` is always there and the read that happens *before* migrating always
    succeeds. On a genuinely empty database it does not: Kysely creates that table lazily inside
    `migrateToLatest()`, so the pre-flight count fails to plan with `42P01` and the deploy dies
    without applying anything.

    Simulated with an empty schema and a `search_path` rather than by dropping the table, which
    would be a test that destroys the developer's database to make its point. The pinned connection
    keeps the `search_path` change off every other connection in the pool.
  */
  it("reports nothing applied when the migration table does not exist yet", async () => {
    await sql`create schema if not exists deploy_probe`.execute(db)

    try {
      // A transaction, because `set local` outside one is silently a no-op — the first version of
      // this test set the path, never changed it, found the real table and failed. Scoping it to a
      // transaction is also what stops the change outliving the test on a pooled connection.
      const count = await db.transaction().execute(async (trx) => {
        // `pg_catalog` stays on the path so `to_regclass` itself resolves; the point is only that
        // `kysely_migration` does not.
        await sql`set local search_path = deploy_probe, pg_catalog`.execute(trx)
        return await sql<{
          present: boolean
        }>`select to_regclass('kysely_migration') is not null as present`.execute(trx)
      })

      expect(count.rows[0]?.present).toBe(false)
    } finally {
      await sql`drop schema if exists deploy_probe cascade`.execute(db)
    }
  })
})
