import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"

export function crudProjectTemplateService(db: Kysely<DB>) {
  async function create(
    data: Insertable<DB["projectTemplateService"]>,
  ): Promise<Selectable<DB["projectTemplateService"]>> {
    return await db
      .insertInto("projectTemplateService")
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function markProvisioned(
    projectId: string,
    serviceKey: string,
  ): Promise<Selectable<DB["projectTemplateService"]> | undefined> {
    return await db
      .updateTable("projectTemplateService")
      .set({ provisionedAt: new Date() })
      .where("projectId", "=", projectId)
      .where("serviceKey", "=", serviceKey)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, markProvisioned }
}
