import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchCreditRetentionState(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["creditRetentionState"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["creditRetentionState"]>, T[number]> | undefined> {
    return await db
      .selectFrom("creditRetentionState")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  return { getOne }
}
