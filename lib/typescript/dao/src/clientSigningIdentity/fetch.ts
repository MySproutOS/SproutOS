import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchClientSigningIdentity(db: Kysely<DB>) {
  async function get<T extends (keyof DB["clientSigningIdentity"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["clientSigningIdentity"]>, T[number]> | undefined> {
    return await db
      .selectFrom("clientSigningIdentity")
      .select(fields)
      .where("packageName", "=", "com.sproutos.store")
      .executeTakeFirst()
  }

  return { get }
}
