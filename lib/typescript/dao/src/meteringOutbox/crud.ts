import type { DB, JsonValue } from "@sproutos/db"
import type { Kysely } from "kysely"

export function crudMeteringOutbox(db: Kysely<DB>) {
  async function create(input: { id: string; eventId: string; payload: JsonValue }): Promise<void> {
    await db
      .insertInto("meteringOutbox")
      .values(input)
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  async function remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await db.deleteFrom("meteringOutbox").where("id", "in", ids).execute()
  }

  /**
   * Insert one provider batch without turning every raw usage row into a Postgres round trip.
   *
   * `event_id` is unique. Retrying an importer after it committed only part of an S3 object is
   * therefore safe: rows already staged in the durable outbox are retained and the remainder is
   * inserted.
   */
  async function createMany(
    inputs: { id: string; eventId: string; payload: JsonValue }[],
  ): Promise<void> {
    if (inputs.length === 0) return
    await db
      .insertInto("meteringOutbox")
      .values(inputs)
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  return { create, createMany, remove }
}
