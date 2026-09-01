import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchBackendService(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["backendService"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["backendService"]>, T[number]> | undefined> {
    return await db
      .selectFrom("backendService")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  return { getInOrganization }
}
