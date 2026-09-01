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

describe.skipIf(!reachable)("Android signing schema", () => {
  it("releases deployment and version uniqueness after a terminal failure", async () => {
    const result = await sql<{ name: string; definition: string }>`
      select indexname as name, indexdef as definition
      from pg_indexes
      where schemaname = current_schema()
        and indexname in (
          'android_signer_job_deployment_key',
          'android_signer_job_version_key'
        )
      order by indexname
    `.execute(db)

    expect(result.rows).toHaveLength(2)
    for (const row of result.rows) {
      expect(row.definition.toLowerCase()).toContain("state <> 'failed'::text")
    }
  })

  it("stores both independent publication gates and the non-secret owning account", async () => {
    const result = await sql<{ columnName: string }>`
      select column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'android_app'
        and column_name in (
          'developer_console_account',
          'developer_console_state',
          'verified_setup_commit'
        )
      order by column_name
    `.execute(db)

    expect(result.rows.map((row) => row.columnName)).toEqual([
      "developer_console_account",
      "developer_console_state",
      "verified_setup_commit",
    ])
  })

  it("rejects registered state when the provider proof is NULL", async () => {
    const userId = crypto.randomUUID()
    const organizationId = crypto.randomUUID()
    const repositoryId = crypto.randomUUID()
    const projectId = crypto.randomUUID()
    const androidAppId = crypto.randomUUID()
    const suffix = projectId.replaceAll("-", "").slice(-12)
    try {
      await db
        .insertInto("user")
        .values({ id: userId, email: `schema-${suffix}@test.invalid` })
        .execute()
      await db
        .insertInto("organization")
        .values({
          id: organizationId,
          slug: `schema-${suffix}`,
          name: "Android schema",
          kind: "team",
          ownerUserId: userId,
        })
        .execute()
      await db
        .insertInto("repository")
        .values({
          id: repositoryId,
          organizationId,
          githubRepoId: BigInt(`0x${suffix}`),
          ownerLogin: "sproutos-test",
          name: `schema-${suffix}`,
          provenance: "new",
        })
        .execute()
      await db
        .insertInto("project")
        .values({
          id: projectId,
          organizationId,
          repositoryId,
          name: "Android schema",
          slug: `schema${suffix.slice(0, 6)}`,
        })
        .execute()
      await db
        .insertInto("androidApp")
        .values({
          id: androidAppId,
          projectId,
          packageName: `me.sproutos.app.p${projectId.replaceAll("-", "")}`,
          certificateSha256: "a".repeat(64),
          keyObjectKey: `keys/${androidAppId}/signing.keystore.enc`,
          keyObjectVersion: "v1",
          developerConsoleAccount: "developerAccounts/123",
          developerConsoleProviderState: null,
        })
        .execute()
      await expect(
        db
          .updateTable("androidApp")
          .set({ developerConsoleState: "registered" })
          .where("id", "=", androidAppId)
          .execute(),
      ).rejects.toThrow(/android_app_registered_identity_check/)
    } finally {
      await db.deleteFrom("project").where("id", "=", projectId).execute()
      await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
      await db.deleteFrom("organization").where("id", "=", organizationId).execute()
      await db.deleteFrom("user").where("id", "=", userId).execute()
    }
  })

  it("makes a signer-selected Android Developer Console account write-once", async () => {
    const row = await db
      .selectFrom("androidApp")
      .select("id")
      .where("developerConsoleAccount", "is not", null)
      .executeTakeFirst()
    if (row === undefined) return
    await expect(
      db
        .updateTable("androidApp")
        .set({ developerConsoleAccount: "developerAccounts/999999" })
        .where("id", "=", row.id)
        .execute(),
    ).rejects.toThrow("developer_console_account is immutable once set")
  })
})
