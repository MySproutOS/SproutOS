import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchProjectUpdateSuggestion(db: Kysely<DB>) {
  /**
   * Suggestions for one project, joined to the sync run that produced them.
   *
   * The run is per *repository* and the suggestion is per *project*, which is the whole point of
   * keeping the two entities apart (TASK 21): one comparison against upstream fans out into one
   * suggestion for every project sharing that repository and branch.
   */
  function listForProjectQuery(projectId: string, status: string | null = null) {
    return db
      .selectFrom("projectUpdateSuggestion")
      .innerJoin(
        "upstreamSyncRun",
        "upstreamSyncRun.id",
        "projectUpdateSuggestion.upstreamSyncRunId",
      )
      .where("projectUpdateSuggestion.projectId", "=", projectId)
      .$if(status !== null, (qb) => qb.where("projectUpdateSuggestion.status", "=", status!))
      .select([
        "projectUpdateSuggestion.id as id",
        "projectUpdateSuggestion.status as status",
        "projectUpdateSuggestion.summary as summary",
        "projectUpdateSuggestion.resolvedAt as resolvedAt",
        "projectUpdateSuggestion.resolvedByUserId as resolvedByUserId",
        "projectUpdateSuggestion.createdAt as createdAt",
        "upstreamSyncRun.id as upstreamSyncRunId",
        "upstreamSyncRun.branch as branch",
        "upstreamSyncRun.behindBy as behindBy",
        "upstreamSyncRun.aheadBy as aheadBy",
        "upstreamSyncRun.outcome as outcome",
        "upstreamSyncRun.mergeType as mergeType",
        "upstreamSyncRun.pullRequestNumber as pullRequestNumber",
        "upstreamSyncRun.pullRequestUrl as pullRequestUrl",
      ])
      .orderBy("projectUpdateSuggestion.id", "desc")
  }

  async function getForProject<T extends (keyof DB["projectUpdateSuggestion"])[]>(
    projectId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["projectUpdateSuggestion"]>, T[number]> | undefined> {
    return await db
      .selectFrom("projectUpdateSuggestion")
      .select(fields)
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  async function countPending(projectId: string): Promise<number> {
    const row = await db
      .selectFrom("projectUpdateSuggestion")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("projectId", "=", projectId)
      .where("status", "=", "pending")
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return { countPending, getForProject, listForProjectQuery }
}
