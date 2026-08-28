import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudClientSignerJob(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["clientSignerJob"]>, "id">,
  ): Promise<Selectable<DB["clientSignerJob"]>> {
    return await db
      .insertInto("clientSignerJob")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["clientSignerJob"]>,
  ): Promise<Selectable<DB["clientSignerJob"]>> {
    return await db
      .updateTable("clientSignerJob")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create, update }
}
