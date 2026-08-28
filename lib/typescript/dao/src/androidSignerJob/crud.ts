import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudAndroidSignerJob(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["androidSignerJob"]>, "id">,
  ): Promise<Selectable<DB["androidSignerJob"]>> {
    return await db
      .insertInto("androidSignerJob")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["androidSignerJob"]>,
  ): Promise<Selectable<DB["androidSignerJob"]> | undefined> {
    return await db
      .updateTable("androidSignerJob")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
