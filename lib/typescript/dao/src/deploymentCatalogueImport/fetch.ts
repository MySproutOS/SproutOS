import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchDeploymentCatalogueImport(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["deploymentCatalogueImport"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["deploymentCatalogueImport"]>, T[number]> | undefined> {
    return await db
      .selectFrom("deploymentCatalogueImport")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  async function latest<T extends (keyof DB["deploymentCatalogueImport"])[]>(
    fields: T,
  ): Promise<Pick<Selectable<DB["deploymentCatalogueImport"]>, T[number]> | undefined> {
    return await db
      .selectFrom("deploymentCatalogueImport")
      .select(fields)
      .orderBy("importedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst()
  }

  return { getOne, latest }
}
