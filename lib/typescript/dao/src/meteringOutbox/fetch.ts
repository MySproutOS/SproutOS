import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchMeteringOutbox(db: Kysely<DB>) {
  /**
   * Claim the oldest unpublished events inside the caller's transaction.
   *
   * The relay publishes while this lock is held and deletes afterward. If it crashes between the
   * two, Kafka receives the same stable event id again and ClickHouse replaces the duplicate. The
   * opposite order would lose a billable event permanently.
   */
  async function claim(limit: number): Promise<Selectable<DB["meteringOutbox"]>[]> {
    return await db
      .selectFrom("meteringOutbox")
      .selectAll()
      .orderBy("createdAt", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()
  }

  return { claim }
}
