import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudDeployment(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["deployment"]>, "id">,
  ): Promise<Selectable<DB["deployment"]>> {
    return await db
      .insertInto("deployment")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["deployment"]>,
  ): Promise<Selectable<DB["deployment"]> | undefined> {
    return await db
      .updateTable("deployment")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Soft delete, per ADR 0017.
   *
   * `usage_event` references a deployment for as long as its billing history exists, so a hard
   * delete would destroy the evidence behind a charge a customer might dispute.
   */
  async function softDelete(id: string): Promise<void> {
    await db
      .updateTable("deployment")
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .execute()
  }

  return { create, softDelete, update }
}
