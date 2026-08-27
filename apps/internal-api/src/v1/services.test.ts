import { db } from "@sproutos/db"
import { sql } from "kysely"
import { describe, expect, it } from "vitest"
import { SERVICE_KINDS } from "./services.serializer"
import { connectionEnvironmentEntries, connectionResponse } from "./services"

describe("service connection contracts", () => {
  it("adds BullMQ's prefix only for Valkey", () => {
    expect(
      connectionEnvironmentEntries({
        connectionUri: "redis://tenant@example.test:6379",
        keyPrefix: "{kv:abc}:bull",
        kind: "valkey",
      }),
    ).toEqual([
      { isSecret: true, key: "REDIS_URL", value: "redis://tenant@example.test:6379" },
      { isSecret: true, key: "VALKEY_URL", value: "redis://tenant@example.test:6379" },
      { isSecret: false, key: "BULLMQ_PREFIX", value: "{kv:abc}:bull" },
    ])
  })

  it("leaves non-Valkey response and environment shapes unchanged", () => {
    const result = { connectionUri: "postgresql://tenant@example.test/database" }
    expect(JSON.stringify(connectionResponse("service-id", result))).toBe(
      '{"id":"service-id","connectionUri":"postgresql://tenant@example.test/database"}',
    )
    expect(connectionEnvironmentEntries({ ...result, kind: "postgres" })).toEqual([
      {
        isSecret: true,
        key: "DATABASE_URL",
        value: "postgresql://tenant@example.test/database",
      },
    ])
  })
})

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

  it("includes the kinds added after the first three", async () => {
    // Named specifically because the original three were added at once and these came later, which
    // is the case where a list and a constraint drift apart.
    // As a map so a failure names the kind that is missing and from which side. `expect(x, label)`
    // would be the obvious way to say that and vitest's matcher takes one argument.
    const allowed = new Set(await allowedKinds())
    const declared = new Set<string>(SERVICE_KINDS)

    expect({
      object_storage: {
        constraint: allowed.has("object_storage"),
        api: declared.has("object_storage"),
      },
      // Withdrawn: it was exposed directly to tenants, which is not how any other datastore here
      // works. See the `drop_couchdb_kind` migration.
      couchdb: { constraint: allowed.has("couchdb"), api: declared.has("couchdb") },
    }).toEqual({
      object_storage: { constraint: true, api: true },
      couchdb: { constraint: false, api: false },
    })
  })
})
