import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchProjectTemplateService(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["projectTemplateService"])[]>(
    projectId: string,
    serviceKey: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectTemplateService"]>, T[number]> | undefined> {
    return await db
      .selectFrom("projectTemplateService")
      .select(fields)
      .where("projectId", "=", projectId)
      .where("serviceKey", "=", serviceKey)
      .executeTakeFirst()
  }

  async function listForProject<T extends (keyof DB["projectTemplateService"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectTemplateService"]>, T[number]>[]> {
    return await db
      .selectFrom("projectTemplateService")
      .select(fields)
      .where("projectId", "=", projectId)
      .orderBy("serviceKey")
      .execute()
  }

  return { getOne, listForProject }
}
