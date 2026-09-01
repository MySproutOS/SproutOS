import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudUpstreamSyncRun(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["upstreamSyncRun"]>, "id">,
  ): Promise<Selectable<DB["upstreamSyncRun"]>> {
    return await db
      .insertInto("upstreamSyncRun")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["upstreamSyncRun"]>,
  ): Promise<Selectable<DB["upstreamSyncRun"]> | undefined> {
    return await db
      .updateTable("upstreamSyncRun")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}

export type RecordSyncRun = {
  repositoryId: string
  branch: string
  outcome: "up_to_date" | "pr_opened" | "merged" | "conflict" | "failed"
  upstreamSha?: string | null
  forkSha?: string | null
  behindBy?: number
  aheadBy?: number
  mergeType?: "merge" | "fast_forward" | "none" | null
  pullRequestNumber?: number | null
  pullRequestUrl?: string | null
  costMicroUsd?: bigint
}

export function recordUpkeepRun(db: Kysely<DB>) {
  /**
   * Record what one upkeep attempt did.
   *
   * A narrowed `create` — the generic one takes the whole Insertable, which lets a caller invent a
   * row with no outcome. Written for every outcome including `up_to_date`, because this history is
   * what `fetchUpkeepStatus` reads to decide whether upkeep is paused: skipping the boring rows
   * would make a repository look like it had failed five times running when it failed once and
   * then had nothing to do for four nights.
   */
  async function record(input: RecordSyncRun): Promise<Selectable<DB["upstreamSyncRun"]>> {
    return await crudUpstreamSyncRun(db).create({
      repositoryId: input.repositoryId,
      branch: input.branch,
      outcome: input.outcome,
      upstreamSha: input.upstreamSha ?? null,
      forkSha: input.forkSha ?? null,
      behindBy: input.behindBy ?? 0,
      aheadBy: input.aheadBy ?? 0,
      mergeType: input.mergeType ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestUrl: input.pullRequestUrl ?? null,
      costMicroUsd: input.costMicroUsd ?? 0n,
    })
  }

  /**
   * Raise a suggestion for every project on the repository.
   *
   * One reconciliation, several projects: TASK 21 lets projects share a repository, so the work
   * happens once and each project gets its own row to accept or dismiss. The unique constraint on
   * (project_id, upstream_sync_run_id) makes a retried job a no-op rather than a duplicate inbox
   * entry.
   */
  async function suggestToProjects(
    upstreamSyncRunId: string,
    projectIds: readonly string[],
    summary: string | null,
  ): Promise<number> {
    if (projectIds.length === 0) return 0

    const inserted = await db
      .insertInto("projectUpdateSuggestion")
      .values(
        projectIds.map((projectId) => ({
          id: v7(),
          projectId,
          upstreamSyncRunId,
          status: "pending",
          summary,
        })),
      )
      .onConflict((oc) => oc.columns(["projectId", "upstreamSyncRunId"]).doNothing())
      .returning("id")
      .execute()

    return inserted.length
  }

  return { record, suggestToProjects }
}
