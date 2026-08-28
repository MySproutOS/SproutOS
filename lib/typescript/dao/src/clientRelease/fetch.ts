import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export const SPROUTOS_ANDROID_PACKAGE = "com.sproutos.store" as const

export function fetchClientRelease(db: Kysely<DB>) {
  async function getByVersion<T extends (keyof DB["clientRelease"])[]>(
    versionCode: number,
    fields: T,
  ): Promise<Pick<Selectable<DB["clientRelease"]>, T[number]> | undefined> {
    return await db
      .selectFrom("clientRelease")
      .select(fields)
      .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
      .where("versionCode", "=", versionCode)
      .executeTakeFirst()
  }

  async function latest<T extends (keyof DB["clientRelease"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["clientRelease"]>, T[number]> | undefined> {
    return await db
      .selectFrom("clientRelease")
      .select(fields)
      .where("packageName", "=", SPROUTOS_ANDROID_PACKAGE)
      .orderBy("versionCode", "desc")
      .limit(1)
      .executeTakeFirst()
  }

  return { getByVersion, latest }
}
