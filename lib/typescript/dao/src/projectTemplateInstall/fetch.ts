import type { DB, Json } from "@sproutos/db"
import { type Kysely, type Selectable, sql } from "kysely"

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

  /** Preserve the signed snake-case document across Kysely's result-name plugin. */
  async function getRawConfiguration(
    projectId: string,
  ): Promise<{ manifest: Json; configuredInputs: Json } | undefined> {
    const result = await db
      .selectFrom("projectTemplateInstall")
      .select([
        sql<string>`manifest::text`.as("manifestJson"),
        sql<string>`configured_inputs::text`.as("configuredInputsJson"),
      ])
      .where("projectId", "=", projectId)
      .executeTakeFirst()
    if (result === undefined) return undefined
    return {
      manifest: JSON.parse(result.manifestJson) as Json,
      configuredInputs: JSON.parse(result.configuredInputsJson) as Json,
    }
  }

  return { getOne, getRawConfiguration }
}
