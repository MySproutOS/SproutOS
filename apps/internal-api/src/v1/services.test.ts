import { db } from "@sproutos/db"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"
import { SERVICE_KINDS } from "./services.serializer"

/**
 * What the API accepts and what the database accepts have to be the same list.
 *
 * They are declared in two places — `SERVICE_KINDS` here and `backend_service_kind_check` in a
 * migration — and a kind in one and not the other fails in one of two ways, neither of which names
 * the cause: a kind the API rejects that the database would have taken is a 400 for something that
 * would have worked, and a kind the API takes that the database refuses is a constraint violation
 * surfacing as a 500.
 *
 * Read from `pg_constraint` rather than restated, for the reason `sandbox_state_check` earned the
 * hard way: a second copy of an enum is a second thing to forget.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

async function allowedKinds(): Promise<string[]> {
  const rows = await sql<{ def: string }>`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'backend_service'::regclass and conname = 'backend_service_kind_check'
  `.execute(db)

  const definition = rows.rows[0]?.def ?? ""
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort()
}

describe.runIf(reachable)("the backend service kinds", () => {
  it("match the constraint, in both directions", async () => {
    expect(await allowedKinds()).toEqual([...SERVICE_KINDS].sort())
  })

  it("includes couchdb, which has a driver", async () => {
    // Named specifically because the previous three were all added at once and this is the first
    // one added later — the case where a list and a constraint drift apart.
    expect(await allowedKinds()).toContain("couchdb")
    expect(SERVICE_KINDS).toContain("couchdb")
  })
})
