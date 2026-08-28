import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"

export function crudProjectTemplateInstall(db: Kysely<DB>) {
  async function create(
    data: Insertable<DB["projectTemplateInstall"]>,
  ): Promise<Selectable<DB["projectTemplateInstall"]>> {
    return await db
      .insertInto("projectTemplateInstall")
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    projectId: string,
    data: Updateable<DB["projectTemplateInstall"]>,
  ): Promise<Selectable<DB["projectTemplateInstall"]> | undefined> {
    return await db
      .updateTable("projectTemplateInstall")
      .set({ ...data, updatedAt: new Date() })
      .where("projectId", "=", projectId)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}
