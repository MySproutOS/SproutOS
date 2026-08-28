import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudStatementLineItem(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["statementLineItem"]>, "id">,
  ): Promise<Selectable<DB["statementLineItem"]>> {
    return await db
      .insertInto("statementLineItem")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { create }
}
