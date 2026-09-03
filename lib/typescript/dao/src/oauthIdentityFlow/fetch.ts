import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchOauthIdentityFlow(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["oauthIdentityFlow"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["oauthIdentityFlow"]>, T[number]> | undefined> {
    return await db
      .selectFrom("oauthIdentityFlow")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  return { getOne }
}
