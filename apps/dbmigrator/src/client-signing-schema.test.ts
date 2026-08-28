import { db } from "@sproutos/db"
import { randomUUID } from "node:crypto"
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

const packageFor = (projectId: string) => `me.sproutos.app.p${projectId.replaceAll("-", "")}`

afterAll(async () => {
  if (reachable) await db.destroy()
})

describe.runIf(reachable)("the catalogue-client signing schema", () => {
  it("binds every tenant package name to its immutable project UUID", async () => {
    const definition = await constraint("android_app", "android_app_project_package_identity_check")
    expect(definition).toContain("me.sproutos.app.p")
    expect(definition).toContain("replace((project_id)::text, '-'::text, ''::text)")

    const suffix = randomUUID().replaceAll("-", "")
    const userId = randomUUID()
    const organizationId = randomUUID()
    const firstRepositoryId = randomUUID()
    const secondRepositoryId = randomUUID()
    const firstProjectId = randomUUID()
    const secondProjectId = randomUUID()
    const appId = randomUUID()

    try {
      await sql`insert into "user" (id, email)
        values (${userId}, ${`${suffix}@example.test`})`.execute(db)
      await sql`insert into organization (id, slug, name, kind, owner_user_id)
        values (${organizationId}, ${`identity-${suffix}`}, 'Identity test', 'personal', ${userId})`.execute(
        db,
      )
      await sql`
        insert into repository
          (id, organization_id, github_repo_id, owner_login, name, provenance)
          values
            (${firstRepositoryId}, ${organizationId}, 1, 'test', 'first', 'new'),
            (${secondRepositoryId}, ${organizationId}, 2, 'test', 'second', 'new')
      `.execute(db)
      await sql`
        insert into project (id, organization_id, repository_id, name, slug)
          values
            (${firstProjectId}, ${organizationId}, ${firstRepositoryId}, 'First', 'first'),
            (${secondProjectId}, ${organizationId}, ${secondRepositoryId}, 'Second', 'second')
      `.execute(db)
      await sql`insert into android_app (id, project_id, package_name)
        values (${appId}, ${firstProjectId}, ${packageFor(firstProjectId)})`.execute(db)

      await expect(
        sql`update android_app set package_name = ${packageFor(secondProjectId)} where id = ${appId}`.execute(
          db,
        ),
      ).rejects.toThrow(/project\/package identity is immutable/)
      await expect(
        sql`update android_app
          set project_id = ${secondProjectId}, package_name = ${packageFor(secondProjectId)}
          where id = ${appId}`.execute(db),
      ).rejects.toThrow(/project\/package identity is immutable/)
    } finally {
      await sql`delete from organization where id = ${organizationId}`.execute(db)
      await sql`delete from "user" where id = ${userId}`.execute(db)
    }
  })

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
    expect(definition).toContain("callback_claim_token")
  })

  it("requires a fresh opaque token exactly while each signer job is claimed", async () => {
    expect(
      await constraint("android_signer_job", "android_signer_job_claim_token_check"),
    ).toContain("claim_token")
    expect(await constraint("client_signer_job", "client_signer_job_claim_token_check")).toContain(
      "claim_token",
    )
  })

  it("stores only bounded non-secret catalogue-client registration state", async () => {
    const state = await constraint(
      "client_signing_identity",
      "client_signing_identity_developer_console_state_check",
    )
    const provider = await constraint(
      "client_signing_identity",
      "client_signing_identity_developer_console_provider_state_check",
    )
    expect(state).toContain("pending_registration")
    expect(state).toContain("registered")
    expect(provider).toContain("REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT")
    expect(
      await constraint(
        "client_signing_identity",
        "client_signing_identity_registered_developer_account_check",
      ),
    ).toContain("developer_console_account IS NOT NULL")
  })
})
