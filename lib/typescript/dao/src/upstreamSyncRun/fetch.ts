import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Upkeep runs are per repository, not per project.
 *
 * One comparison against upstream serves every project on that repository and branch — which is
 * why `upstream_sync_run.repository_id` exists and there is no `project_id` on it.
 */
export function fetchUpstreamSyncRun(db: Kysely<DB>) {
  async function listForRepository<T extends (keyof DB["upstreamSyncRun"])[]>(
    repositoryId: string,
    fields: T,
    limit = 20,
  ): Promise<Pick<Selectable<DB["upstreamSyncRun"]>, T[number]>[]> {
    return await db
      .selectFrom("upstreamSyncRun")
      .select(fields)
      .where("repositoryId", "=", repositoryId)
      .orderBy("id", "desc")
      .limit(limit)
      .execute()
  }

  async function getLatest<T extends (keyof DB["upstreamSyncRun"])[]>(
    repositoryId: string,
    branch: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["upstreamSyncRun"]>, T[number]> | undefined> {
    return await db
      .selectFrom("upstreamSyncRun")
      .select(fields)
      .where("repositoryId", "=", repositoryId)
      .where("branch", "=", branch)
      .orderBy("id", "desc")
      .executeTakeFirst()
  }

  return { getLatest, listForRepository }
}
