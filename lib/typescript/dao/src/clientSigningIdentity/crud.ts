import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudClientSigningIdentity(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["clientSigningIdentity"]>, "id">,
  ): Promise<Selectable<DB["clientSigningIdentity"]>> {
    return await db
      .insertInto("clientSigningIdentity")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["clientSigningIdentity"]>,
  ): Promise<Selectable<DB["clientSigningIdentity"]>> {
    return await db
      .updateTable("clientSigningIdentity")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create, update }
}
