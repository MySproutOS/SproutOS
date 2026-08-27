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

  return { create, remove }
}
