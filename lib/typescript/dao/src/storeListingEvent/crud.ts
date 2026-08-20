import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export type StoreListingEventKind = "view" | "visit_upstream" | "fork_started" | "fork_completed"

export function crudStoreListingEvent(db: Kysely<DB>) {
  /**
   * Appends one interaction with a listing.
   *
   * `user_id` is nullable because the store is browsable signed out (TASK 4) — an anonymous view
   * is still a view, and attributing it to nobody is more honest than not recording it.
   */
  async function record(entry: {
    storeListingId: string
    userId: string | null
    kind: StoreListingEventKind
  }): Promise<Selectable<DB["storeListingEvent"]>> {
    return await db
      .insertInto("storeListingEvent")
      .values({
        id: v7(),
        storeListingId: entry.storeListingId,
        userId: entry.userId,
        kind: entry.kind,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { record }
}
