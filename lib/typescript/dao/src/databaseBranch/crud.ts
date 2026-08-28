import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudDatabaseBranch(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["databaseBranch"]>, "id">,
  ): Promise<Selectable<DB["databaseBranch"]>> {
    return await db
      .insertInto("databaseBranch")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create }
}
