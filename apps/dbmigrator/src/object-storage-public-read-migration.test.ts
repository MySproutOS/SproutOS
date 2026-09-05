import { db } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import {
  down as downPublicRead,
  up as upPublicRead,
} from "./migrations/2026_11_22_00_00_00_object_storage_public_read"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

afterAll(async () => db.destroy())

describe.skipIf(!reachable)("object-storage public-read migration", () => {
  it("defaults every service to private and confines public reads to object storage", async () => {
    const schema = `object_storage_access_probe_${process.pid}`
    await sql.raw(`create schema ${schema}`).execute(db)

    try {
      await db.transaction().execute(async (transaction) => {
        await sql.raw(`set local search_path = ${schema}, pg_catalog`).execute(transaction)
        await sql`create table backend_service (
          id uuid primary key,
          kind text not null
        )`.execute(transaction)
        await sql`insert into backend_service values
          ('00000000-0000-4000-8000-000000000001', 'object_storage'),
          ('00000000-0000-4000-8000-000000000002', 'postgres')`.execute(transaction)

        const migrationDb = transaction as unknown as Kysely<unknown>
        await upPublicRead(migrationDb)

        const defaults = await sql<{ publicRead: boolean }>`
          select public_read as "publicRead" from backend_service order by id
        `.execute(transaction)
        expect(defaults.rows).toEqual([{ publicRead: false }, { publicRead: false }])

        await sql`update backend_service set public_read = true
          where kind = 'object_storage'`.execute(transaction)
        await sql`savepoint reject_non_storage`.execute(transaction)
        let rejected: unknown
        try {
          await sql`update backend_service set public_read = true
            where kind = 'postgres'`.execute(transaction)
        } catch (cause) {
          rejected = cause
        }
        await sql`rollback to savepoint reject_non_storage`.execute(transaction)
        await sql`release savepoint reject_non_storage`.execute(transaction)
        expect(rejected).toMatchObject({ code: "23514" })

        await downPublicRead(migrationDb)
        const columns = await sql<{ columnName: string }>`
          select column_name as "columnName"
          from information_schema.columns
          where table_schema = ${schema}
            and table_name = 'backend_service'
            and column_name = 'public_read'
        `.execute(transaction)
        expect(columns.rows).toEqual([])
      })
    } finally {
      await sql.raw(`drop schema if exists ${schema} cascade`).execute(db)
    }
  })
})
