import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchAndroidSignerInstance(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["androidSignerInstance"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidSignerInstance"]>, T[number]> | undefined> {
    return await db
      .selectFrom("androidSignerInstance")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function latest<T extends (keyof DB["androidSignerInstance"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["androidSignerInstance"]>, T[number]> | undefined> {
    return await db
      .selectFrom("androidSignerInstance")
      .select(fields)
      .orderBy("lastSeenAt", "desc")
      .executeTakeFirst()
  }

  return { getOne, latest }
}
