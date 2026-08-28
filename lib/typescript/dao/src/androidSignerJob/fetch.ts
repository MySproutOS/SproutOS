import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchAndroidSignerJob(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["androidSignerJob"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidSignerJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("androidSignerJob")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function listForApp<T extends (keyof DB["androidSignerJob"])[]>(
    androidAppId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["androidSignerJob"]>, T[number]>[]> {
    return await db
      .selectFrom("androidSignerJob")
      .select(fields)
      .where("androidAppId", "=", androidAppId)
      .orderBy("createdAt", "desc")
      .execute()
  }

  return { getOne, listForApp }
}
