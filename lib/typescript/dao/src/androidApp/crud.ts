import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudAndroidApp(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["androidApp"]>, "id">,
  ): Promise<Selectable<DB["androidApp"]>> {
    return await db
      .insertInto("androidApp")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["androidApp"]>,
  ): Promise<Selectable<DB["androidApp"]> | undefined> {
    return await db
      .updateTable("androidApp")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
