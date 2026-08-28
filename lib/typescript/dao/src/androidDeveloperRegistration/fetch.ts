import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Selectable } from "kysely"

export function fetchAndroidDeveloperRegistration(db: Kysely<DB>) {
  async function getForProject<T extends (keyof DB["androidDeveloperRegistration"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidDeveloperRegistration"]>, T[number]> | undefined> {
    return await db
      .selectFrom("androidDeveloperRegistration")
      .select(fields)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  async function readiness(projectId: string): Promise<boolean> {
    const row = await db
      .selectFrom("androidDeveloperRegistration")
      .select("id")
      .where("projectId", "=", projectId)
      .where("state", "=", "registered")
      .where("providerState", "=", "REGISTERED")
      .where("verifiedSetupCommit", "is not", null)
      .executeTakeFirst()
    return row !== undefined
  }

  async function queueHealth(now: Date) {
    const queue = await db
      .selectFrom("androidDeveloperRegistration")
      .select([
        sql<string>`count(*) filter (where state <> 'registered')`.as("pendingCount"),
        sql<string>`count(*) filter (where state <> 'registered' and next_check_at <= ${now})`.as(
          "dueCount",
        ),
        sql<Date | null>`min(next_check_at) filter (where state <> 'registered')`.as(
          "oldestNextCheckAt",
        ),
      ])
      .executeTakeFirstOrThrow()
    const worker = await db
      .selectFrom("androidRegistrationReconcilerState")
      .select(["lastSeenAt", "lastCompletedAt", "lastFailure"])
      .where("id", "=", "developer-id-status")
      .executeTakeFirstOrThrow()
    return { ...queue, ...worker }
  }

  return { getForProject, queueHealth, readiness }
}
