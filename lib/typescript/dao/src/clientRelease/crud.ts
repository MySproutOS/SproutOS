import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudClientRelease(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["clientRelease"]>, "id">,
  ): Promise<Selectable<DB["clientRelease"]>> {
    return await db
      .insertInto("clientRelease")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create }
}
