import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import { PartialBy } from "../utils/types"

export function crudUser(db: Kysely<DB>) {
  async function createUser(
    data: PartialBy<Insertable<DB["user"]>, "id">,
  ): Promise<Selectable<DB["user"]>> {
    const values = { id: data.id ?? v7(), ...data }
    return await db.transaction().execute(async (tx) => {
      return await tx.insertInto("user").values(values).returningAll().executeTakeFirstOrThrow()
    })
  }

  async function deleteUser(userId: string): Promise<boolean> {
    try {
      await db.transaction().execute(async (tx) => {
        await tx.deleteFrom("user").where("id", "=", userId).execute()
      })
      return true
    } catch {
      return false
    }
  }

  return { createUser, deleteUser }
}
