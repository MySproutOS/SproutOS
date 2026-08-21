import { db } from "@sproutos/db"
import { sql } from "kysely"

/**
 * Serialize test files that drive a **platform-wide** job.
 *
 * `rollUpUsage` and `chargeUsage` do not take an organization. They cannot: their job is to sweep
 * everything that is owed, and a version that swept one tenant would need a caller that knew which
 * tenants exist. That is right for production and awkward for tests, because vitest runs files in
 * parallel against one database — so `rollup.test.ts` calling `rollUpUsage` claims and rolls up the
 * events `charge.test.ts` had just written, and vice versa.
 *
 * The failures that produces are the confusing kind. `rollup.test.ts` asserted a grain of 1.75 and
 * found 3.75, because another file's sweep had folded in an event it had not rolled up yet; the
 * assertion that broke was in the file that had done nothing wrong.
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
