import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * `project_job` has no `deleted_at` — it is an operation log, not a resource — but every read is
 * still scoped by organization, because the job id is the thing a polling client holds and it
 * arrives from the URL unverified.
 */
export function fetchProjectJob(db: Kysely<DB>) {
  async function getInOrganization<T extends (keyof DB["projectJob"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("projectJob")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function getByIdempotencyKey<T extends (keyof DB["projectJob"])[]>(
    key: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectJob"]>, T[number]> | undefined> {
    return await db
      .selectFrom("projectJob")
      .select(fields)
      .where("idempotencyKey", "=", key)
      .executeTakeFirst()
  }

  async function listForProject<T extends (keyof DB["projectJob"])[]>(
    organizationId: string,
    projectId: string,
    fields: T,
    limit = 20,
  ): Promise<Pick<Selectable<DB["projectJob"]>, T[number]>[]> {
    return await db
      .selectFrom("projectJob")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("projectId", "=", projectId)
      .orderBy("id", "desc")
      .limit(limit)
      .execute()
  }

  return { getByIdempotencyKey, getInOrganization, listForProject }
}
