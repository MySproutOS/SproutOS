import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudAndroidSignerInstance(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["androidSignerInstance"]>, "id">,
  ): Promise<Selectable<DB["androidSignerInstance"]>> {
    return await db
      .insertInto("androidSignerInstance")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["androidSignerInstance"]>,
  ): Promise<Selectable<DB["androidSignerInstance"]> | undefined> {
    return await db
      .updateTable("androidSignerInstance")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  async function touch(signerId: string, at: Date): Promise<void> {
    await db
      .insertInto("androidSignerInstance")
      .values({ id: v7(), signerId, lastSeenAt: at })
      .onConflict((conflict) =>
        conflict.column("signerId").doUpdateSet({ lastSeenAt: at, updatedAt: at }),
      )
      .execute()
  }

  return { create, update, touch }
}
