import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudStatement(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["statement"]>, "id">,
  ): Promise<Selectable<DB["statement"]>> {
    return await db
      .insertInto("statement")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create }
}
