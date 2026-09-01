import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchCreditRetentionState(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["creditRetentionState"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["creditRetentionState"]>, T[number]> | undefined> {
    return await db
      .selectFrom("creditRetentionState")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function isUsageSuspended(organizationId: string): Promise<boolean> {
    const row = await db
      .selectFrom("creditRetentionState")
      .select("organizationId")
      .where("organizationId", "=", organizationId)
      .where("status", "in", ["suspended", "deleting", "data_deleted"])
      .executeTakeFirst()
    return row !== undefined
  }

  async function isProjectUsageSuspended(projectId: string): Promise<boolean> {
    const row = await db
      .selectFrom("project")
      .innerJoin(
        "creditRetentionState",
        "creditRetentionState.organizationId",
        "project.organizationId",
      )
      .select("project.id")
      .where("project.id", "=", projectId)
      .where("creditRetentionState.status", "in", ["suspended", "deleting", "data_deleted"])
      .executeTakeFirst()
    return row !== undefined
  }

  return { getOne, isProjectUsageSuspended, isUsageSuspended }
}
