import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchStoreCategory(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["storeCategory"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["storeCategory"]>, T[number]> | undefined> {
    return await db
      .selectFrom("storeCategory")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function getBySlug<T extends (keyof DB["storeCategory"])[]>(
    slug: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["storeCategory"]>, T[number]> | undefined> {
    return await db
      .selectFrom("storeCategory")
      .select(fields)
      .where("slug", "=", slug)
      .executeTakeFirst()
  }

  async function listAll<T extends (keyof DB["storeCategory"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["storeCategory"]>, T[number]>[]> {
    return await db
      .selectFrom("storeCategory")
      .select(fields)
      .orderBy("sortOrder", "asc")
      .orderBy("name", "asc")
      .execute()
  }

  return { getBySlug, getOne, listAll }
}
