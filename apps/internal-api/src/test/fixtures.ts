import { db } from "@sproutos/db"
import { encodeHexLowerCase, generateSessionToken, sha256Utf8 } from "@utils/crypto"
import { sql } from "kysely"
import { v7 } from "uuid"

/**
 * Fixtures for the RBAC suite, which runs against the compose Postgres rather than a mock.
 *
 * Authorization is a property of the schema — the GIN index, the cascades, the partial unique
 * index, `bool_or` over rows from two different roles — so a stubbed database would test the
 * stub. The suite skips when Postgres is unreachable so a checkout without Docker still runs.
 */
export async function databaseReachable(): Promise<boolean> {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
}

export type TestUser = {
  id: string
  email: string
  name: string
  sessionToken: string
}

const created = { userIds: [] as string[], organizationIds: [] as string[] }

export async function createTestUser(label: string): Promise<TestUser> {
  const id = v7()
  // The whole id, not a prefix. The first 8 hex characters of a UUIDv7 are the *high* bits of the
  // millisecond timestamp, so they are identical for roughly 71 minutes — two runs of the same
  // suite inside that window collided on user_email_key.
  const email = `${label}-${id}@rbac.test`
  const name = `Test ${label}`

  await db.insertInto("user").values({ id, email, name, isAdmin: false }).execute()
  created.userIds.push(id)

  const sessionToken = generateSessionToken()
  await db
    .insertInto("session")
    .values({
      sessionKey: encodeHexLowerCase(await sha256Utf8(sessionToken)),
      userId: id,
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24),
    })
    .execute()

  return { id, email, name, sessionToken }
}

/** Registers an organization the suite created so teardown can reach it. */
export function trackOrganization(organizationId: string): string {
  created.organizationIds.push(organizationId)
  return organizationId
}

export function authHeaders(user: TestUser): Record<string, string> {
  return { Cookie: `session=${user.sessionToken}`, "Content-Type": "application/json" }
}

/**
 * Removes everything the suite created.
 *
 * `audit_log` carries a `BEFORE UPDATE OR DELETE` trigger and `ON DELETE RESTRICT` to both
 * `organization` and `user`, so its rows have to go first and the trigger has to be off while
 * they do. That is only acceptable because this runs against a local test database; nothing in
 * the application ever disables it.
 */
export async function cleanupFixtures(): Promise<void> {
  if (created.organizationIds.length === 0 && created.userIds.length === 0) return

  await sql`alter table audit_log disable trigger audit_log_append_only`.execute(db)
  try {
    if (created.organizationIds.length > 0) {
      await db
        .deleteFrom("auditLog")
        .where("organizationId", "in", created.organizationIds)
        .execute()
    }
    if (created.userIds.length > 0) {
      await db.deleteFrom("auditLog").where("actorUserId", "in", created.userIds).execute()
    }
  } finally {
    await sql`alter table audit_log enable trigger audit_log_append_only`.execute(db)
  }

  if (created.organizationIds.length > 0) {
    await db.deleteFrom("organization").where("id", "in", created.organizationIds).execute()
  }
  if (created.userIds.length > 0) {
    await db.deleteFrom("user").where("id", "in", created.userIds).execute()
  }

  created.organizationIds.length = 0
  created.userIds.length = 0
}
