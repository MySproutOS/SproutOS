import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudUpstreamSyncRun(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["upstreamSyncRun"]>, "id">,
  ): Promise<Selectable<DB["upstreamSyncRun"]>> {
    return await db
      .insertInto("upstreamSyncRun")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["upstreamSyncRun"]>,
  ): Promise<Selectable<DB["upstreamSyncRun"]> | undefined> {
    return await db
      .updateTable("upstreamSyncRun")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
