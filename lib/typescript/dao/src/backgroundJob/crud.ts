import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudBackgroundJob(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["backgroundJob"]>, "id">,
  ): Promise<Selectable<DB["backgroundJob"]>> {
    return await db
      .insertInto("backgroundJob")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function enqueueOnce(
    data: PartialBy<Insertable<DB["backgroundJob"]>, "id">,
  ): Promise<Selectable<DB["backgroundJob"]> | undefined> {
    return await db
      .insertInto("backgroundJob")
      .values({ id: v7(), ...data })
      .onConflict((oc) => oc.column("idempotencyKey").doNothing())
      .returningAll()
      .executeTakeFirst()
  }

  async function update(
    id: string,
    data: Updateable<DB["backgroundJob"]>,
  ): Promise<Selectable<DB["backgroundJob"]> | undefined> {
    return await db
      .updateTable("backgroundJob")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, enqueueOnce, update }
}
