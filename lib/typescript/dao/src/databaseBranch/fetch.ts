import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchDatabaseBranch(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["databaseBranch"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["databaseBranch"]>, T[number]> | undefined> {
    return await db
      .selectFrom("databaseBranch")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function expiredUnprotected(now: Date, limit: number): Promise<{ id: string }[]> {
    return await db
      .selectFrom("databaseBranch")
      .select("id")
      .where("expiresAt", "is not", null)
      .where("expiresAt", "<=", now)
      .where("isProtected", "=", false)
      .where((eb) => eb.or([eb("cleanupRetryAt", "is", null), eb("cleanupRetryAt", "<=", now)]))
      .orderBy("expiresAt", "asc")
      .limit(limit)
      .execute()
  }

  return { expiredUnprotected, getOne }
}
