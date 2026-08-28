import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchClientSignerJob(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["clientSignerJob"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["clientSignerJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("clientSignerJob")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  return { getOne }
}
