import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchStoreListingScreenshot(db: Kysely<DB>) {
  async function listForListing<T extends (keyof DB["storeListingScreenshot"])[]>(
    storeListingId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["storeListingScreenshot"]>, T[number]>[]> {
    return await db
      .selectFrom("storeListingScreenshot")
      .select(fields)
      .where("storeListingId", "=", storeListingId)
      .orderBy("sortOrder", "asc")
      .orderBy("id", "asc")
      .execute()
  }

  return { listForListing }
}
