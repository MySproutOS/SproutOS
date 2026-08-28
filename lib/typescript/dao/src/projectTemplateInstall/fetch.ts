import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchProjectTemplateInstall(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["projectTemplateInstall"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectTemplateInstall"]>, T[number]> | undefined> {
    return await db
      .selectFrom("projectTemplateInstall")
      .select(fields)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  return { getOne }
}
