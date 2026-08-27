import { db } from "@sproutos/db"
import { sql } from "kysely"

/**
 * Serialize test files that drive a **platform-wide** job.
 *
 * `chargeUsage` does not take an organization. It cannot: its job is to sweep everything that is
 * owed, and a version that swept one tenant would need a caller that knew which tenants exist.
 * That is right for production and awkward for tests, because Vitest runs files in parallel
 * against one database.
 *
 * The failures that produces are the confusing kind: one file can charge another file's fixture,
 * and the assertion that breaks is in the file that did nothing wrong.
 *
 * A Postgres advisory lock held for the file's lifetime makes those files take turns. Session-scoped
 * rather than transaction-scoped because the tests span many transactions, and it is released
 * explicitly in `afterAll` — a dropped connection releases it anyway, so a crashed run does not
 * wedge the next one.
 */
export async function acquirePlatformJobLock(): Promise<void> {
  await sql`select pg_advisory_lock(${PLATFORM_JOB_LOCK})`.execute(db)
}

export async function releasePlatformJobLock(): Promise<void> {
  await sql`select pg_advisory_unlock(${PLATFORM_JOB_LOCK})`.execute(db)
}

/** An arbitrary constant. Only its uniqueness within this database matters. */
export const PLATFORM_JOB_LOCK = 728_114_509
