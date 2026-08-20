import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchStoreListingTag(db: Kysely<DB>) {
  async function listForListing(storeListingId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("storeListingTag")
      .select("tag")
      .where("storeListingId", "=", storeListingId)
      .orderBy("tag", "asc")
      .execute()

    return rows.map((row) => row.tag)
  }

  /**
   * Tags for a whole page of listings in one query.
   *
   * The browse response carries tags per card, and fetching them per row would make a 25-item
   * page 26 round trips.
   */
  async function listForListings(
    storeListingIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>()
    if (storeListingIds.length === 0) return grouped

    const rows = await db
      .selectFrom("storeListingTag")
      .select(["storeListingId", "tag"])
      .where("storeListingId", "in", [...storeListingIds])
      .orderBy("tag", "asc")
      .execute()

    for (const row of rows) {
      const existing = grouped.get(row.storeListingId)
      if (existing === undefined) grouped.set(row.storeListingId, [row.tag])
      else existing.push(row.tag)
    }

    return grouped
  }

  async function listDistinct(limit: number): Promise<string[]> {
    const rows = await db
      .selectFrom("storeListingTag")
      .innerJoin("storeListing", "storeListing.id", "storeListingTag.storeListingId")
      .select("storeListingTag.tag as tag")
      .where("storeListing.deletedAt", "is", null)
      .where("storeListing.status", "=", "published")
      .distinct()
      .orderBy("storeListingTag.tag", "asc")
      .limit(limit)
      .execute()

    return rows.map((row) => row.tag)
  }

  return { listDistinct, listForListing, listForListings }
}

export type StoreListingTagRow = Selectable<DB["storeListingTag"]>
