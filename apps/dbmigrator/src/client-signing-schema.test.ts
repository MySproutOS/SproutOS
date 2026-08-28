import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

async function constraint(table: string, name: string): Promise<string> {
  const result = await sql<{ definition: string }>`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = ${table}::regclass and conname = ${name}
  `.execute(db)
  return result.rows[0]?.definition ?? ""
}

afterAll(async () => {
  if (reachable) await db.destroy()
})

describe.runIf(reachable)("the catalogue-client signing schema", () => {
  it("fixes the singleton package and immutable key path", async () => {
    expect(
      await constraint("client_signing_identity", "client_signing_identity_package_check"),
    ).toContain("com.sproutos.store")
    expect(
      await constraint("client_signing_identity", "client_signing_identity_key_shape_check"),
    ).toContain("keys/client/signing.keystore.enc")
  })

  it("requires immutable raw and signed object keys and exact object versions", async () => {
    const raw = await constraint("client_signer_job", "client_signer_job_shape_check")
    const signed = await constraint("client_signer_job", "client_signer_job_signed_shape_check")
    expect(raw).toContain("raw/client/")
    expect(raw).toContain("length(unsigned_object_version) > 0")
    expect(signed).toContain("signed/client/")
    expect(signed).toContain("length(signed_object_version) > 0")
  })

  it("enforces Android's actual versionCode maximum on jobs and releases", async () => {
    expect(await constraint("client_signer_job", "client_signer_job_shape_check")).toContain(
      "2100000000",
    )
    expect(await constraint("client_release", "client_release_version_code_check")).toContain(
      "2100000000",
    )
  })

  it("binds callback replay state to a callback kind and signer", async () => {
    const definition = await constraint("client_signer_job", "client_signer_job_idempotency_check")
    expect(definition).toContain("callback_kind")
    expect(definition).toContain("callback_signer_id")
  })
})
