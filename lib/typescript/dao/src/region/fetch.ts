import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchRegion(db: Kysely<DB>) {
  async function getActiveByCode<T extends (keyof DB["region"])[]>(
    code: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["region"]>, T[number]> | undefined> {
    return await db
      .selectFrom("region")
      .select(fields)
      .where("code", "=", code)
      .where("isActive", "=", true)
      .executeTakeFirst()
  }

  return { getActiveByCode }
}
