import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"

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

describe.skipIf(!reachable)("signed deployment catalogue schema", () => {
  it("keeps PostgreSQL full-text search authoritative", async () => {
    const result = await sql<{ definition: string }>`
      select pg_get_indexdef(indexrelid) as definition
      from pg_index
      where indexrelid = 'store_listing_search_vector_gin_idx'::regclass
    `.execute(db)
    expect(result.rows[0]?.definition.toLowerCase()).toContain("using gin (search_vector)")
  })

  it("makes imported publication evidence a database invariant", async () => {
    const result = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'store_listing'::regclass
        and conname = 'store_listing_catalogue_publication_check'
    `.execute(db)
    const definition = result.rows[0]?.definition ?? ""
    expect(definition).toContain("capability_verified_at IS NOT NULL")
    expect(definition).toContain("e2e_verified_at IS NOT NULL")

    const unsafe = await db
      .selectFrom("storeListing")
      .select("id")
      .where("catalogueEntryId", "is not", null)
      .where("status", "=", "published")
      .where((eb) =>
        eb.or([
          eb("catalogueArchivedAt", "is not", null),
          eb("capabilityVerifiedAt", "is", null),
          eb("e2eVerifiedAt", "is", null),
        ]),
      )
      .execute()
    expect(unsafe).toEqual([])
  })
})
