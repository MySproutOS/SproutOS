import { db } from "@sproutos/db"
import { encodeHexLowerCase, generateSessionToken, sha256Utf8 } from "@utils/crypto"
import { sql } from "kysely"
import { v7 } from "uuid"
import { Redis } from "ioredis"

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

/**
 * Whether the LocalStack KMS behind `@lib/envelope` is up.
 *
 * Separate from `databaseReachable` because CI has Postgres but not LocalStack: the image is
 * token-gated, so running it in Actions needs `LOCALSTACK_AUTH_TOKEN` as a repository secret and
 * a licensing decision that is not a test's to make. Suites that seal or open a secret skip
 * without it; everything else still runs.
 */
export async function kmsReachable(): Promise<boolean> {
  // The routes call seal() with no explicit config, so the key has to come from the environment.
  // A machine running LocalStack without KMS_KEY_ID should skip, not fail with MissingKeyError.
  if ((process.env.KMS_KEY_ID ?? "") === "") return false

  const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
  try {
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
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
      // Impersonation puts the admin's id on the row as well, and that reference is RESTRICT too.
      await db.deleteFrom("auditLog").where("impersonatorUserId", "in", created.userIds).execute()
    }
  } finally {
    await sql`alter table audit_log enable trigger audit_log_append_only`.execute(db)
  }

  if (created.organizationIds.length > 0) {
    await db.deleteFrom("organization").where("id", "in", created.organizationIds).execute()
  }
  if (created.userIds.length > 0) {
    /*
      Sessions first, and by *impersonator* as well as by owner.

      `session.impersonated_by_user_id` is `ON DELETE RESTRICT`, like every reference to `user` —
      an admin who closes their account must not take the evidence with them. Ordinary sessions
      cascade, so this only matters for impersonated ones, and it only surfaced as an intermittent
      failure: whether it fired depended on which suite tore down first.
    */
    await db.deleteFrom("session").where("impersonatedByUserId", "in", created.userIds).execute()
    await db.deleteFrom("user").where("id", "in", created.userIds).execute()
  }

  created.organizationIds.length = 0
  created.userIds.length = 0
}

/**
 * Whether the shared Valkey that tenant queues live on is reachable.
 *
 * On a developer's machine an absent service is a skip: `pnpm test` should not fail because docker
 * is not running. **In CI it throws.** A skipped test looks exactly like a passing one in the
 * summary, so a workflow that lost its service container would go on reporting green while the
 * tests that check one tenant cannot read another's jobs had stopped running entirely.
 */
export async function tenantValkeyReachable(): Promise<boolean> {
  const url = process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://127.0.0.1:41023"
  const probe = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  })

  let up = false
  try {
    await probe.connect()
    await probe.ping()
    up = true
  } catch {
    up = false
  } finally {
    probe.disconnect()
  }

  if (!up && process.env.CI !== undefined) {
    throw new Error(
      `The tenant Valkey at ${url} is not reachable in CI. These tests must not silently skip here.`,
    )
  }
  return up
}
