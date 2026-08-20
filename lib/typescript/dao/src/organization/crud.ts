import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudOrganization(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["organization"]>, "id">,
  ): Promise<Selectable<DB["organization"]>> {
    return await db
      .insertInto("organization")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["organization"]>,
  ): Promise<Selectable<DB["organization"]> | undefined> {
    return await db
      .updateTable("organization")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Soft delete, per ADR 0017. The row stays so `usage_event` can still resolve last month's line
   * items to a named organization; a teardown job clears the external resources afterwards.
   *
   * The slug is left alone. `organization_slug_live_key` is partial on `deleted_at IS NULL`, so
   * deleting the row releases the name for reuse without rewriting anything.
   */
  async function softDelete(id: string): Promise<boolean> {
    const result = await db
      .updateTable("organization")
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  async function setOwner(
    id: string,
    ownerUserId: string,
  ): Promise<Selectable<DB["organization"]> | undefined> {
    return await db
      .updateTable("organization")
      .set({ ownerUserId, updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, setOwner, softDelete, update }
}
