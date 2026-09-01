import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"

export function crudCreditRetentionState(db: Kysely<DB>) {
  async function upsert(
    organizationId: string,
    data: Omit<Insertable<DB["creditRetentionState"]>, "organizationId">,
  ): Promise<Selectable<DB["creditRetentionState"]>> {
    return await db
      .insertInto("creditRetentionState")
      .values({ organizationId, ...data })
      .onConflict((conflict) =>
        conflict.column("organizationId").doUpdateSet({ ...data, updatedAt: new Date() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    organizationId: string,
    data: Updateable<DB["creditRetentionState"]>,
  ): Promise<Selectable<DB["creditRetentionState"]> | undefined> {
    return await db
      .updateTable("creditRetentionState")
      .set({ ...data, updatedAt: new Date() })
      .where("organizationId", "=", organizationId)
      .returningAll()
      .executeTakeFirst()
  }

  return { update, upsert }
}
