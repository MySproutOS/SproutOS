import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudBackendService(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["backendService"]>, "id">,
  ): Promise<Selectable<DB["backendService"]>> {
    return await db
      .insertInto("backendService")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    organizationId: string,
    id: string,
    data: Updateable<DB["backendService"]>,
  ): Promise<Selectable<DB["backendService"]> | undefined> {
    return await db
      .updateTable("backendService")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
