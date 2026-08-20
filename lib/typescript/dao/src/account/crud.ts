import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import { PartialBy } from "../utils/types"

export function crudAccount(db: Kysely<DB>) {
  async function createAccount(
    data: PartialBy<Insertable<DB["account"]>, "id">,
  ): Promise<Selectable<DB["account"]>> {
    const values = { id: data.id ?? v7(), ...data }
    return await db.transaction().execute(async (tx) => {
      return await tx.insertInto("account").values(values).returningAll().executeTakeFirstOrThrow()
    })
  }

  return { createAccount }
}
