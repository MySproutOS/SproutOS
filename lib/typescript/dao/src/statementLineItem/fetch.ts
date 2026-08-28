import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchStatementLineItem(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["statementLineItem"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["statementLineItem"]>, T[number]> | undefined> {
    return await db
      .selectFrom("statementLineItem")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function getMany<T extends (keyof DB["statementLineItem"])[]>(
    statementId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["statementLineItem"]>, T[number]>[]> {
    return await db
      .selectFrom("statementLineItem")
      .select(fields)
      .where("statementId", "=", statementId)
      .execute()
  }

  return { getMany, getOne }
}
