import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import { PartialBy } from "../utils/types"

export function crudAccount(db: Kysely<DB>) {
  async function createAccount(
    data: PartialBy<Insertable<DB["account"]>, "id">,
  ): Promise<Selectable<DB["account"]>> {
    const values = { id: data.id ?? v7(), ...data }
    return await db.insertInto("account").values(values).returningAll().executeTakeFirstOrThrow()
  }

  async function updateAccount(
    id: string,
    userId: string,
    data: Updateable<DB["account"]>,
  ): Promise<Selectable<DB["account"]> | undefined> {
    return await db
      .updateTable("account")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("userId", "=", userId)
      .returningAll()
      .executeTakeFirst()
  }

  async function deleteAccount(id: string, userId: string): Promise<boolean> {
    const result = await db
      .deleteFrom("account")
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst()
    return Number(result.numDeletedRows) === 1
  }

  return { createAccount, deleteAccount, updateAccount }
}
