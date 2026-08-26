import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"

export type MeteringOutboxClaim = {
  id: string
  eventId: string
  /** JSONB rendered as text so CamelCasePlugin cannot rewrite the wire object's snake-case keys. */
  payload: string
}

export function fetchMeteringOutbox(db: Kysely<DB>) {
  /**
   * Claim the oldest unpublished events inside the caller's transaction.
   *
   * The relay publishes while this lock is held and deletes afterward. If it crashes between the
   * two, Kafka receives the same stable event id again and ClickHouse replaces the duplicate. The
   * opposite order would lose a billable event permanently.
   */
  async function claim(limit: number): Promise<MeteringOutboxClaim[]> {
    return await db
      .selectFrom("meteringOutbox")
      .select(["id", "eventId", sql<string>`payload::text`.as("payload")])
      .orderBy("createdAt", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute()
  }

  return { claim }
}
