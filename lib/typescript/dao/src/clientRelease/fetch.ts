import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchClientRelease(db: Kysely<DB>) {
  async function latest<T extends (keyof DB["clientRelease"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["clientRelease"]>, T[number]> | undefined> {
    return await db
      .selectFrom("clientRelease")
      .select(fields)
      .where("packageName", "=", "me.sproutos.client")
      .orderBy("versionCode", "desc")
      .limit(1)
      .executeTakeFirst()
  }

  return { latest }
}
