import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export type SuggestionStatus = "pending" | "accepted" | "dismissed" | "applied"

export function crudProjectUpdateSuggestion(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["projectUpdateSuggestion"]>, "id">,
  ): Promise<Selectable<DB["projectUpdateSuggestion"]>> {
    return await db
      .insertInto("projectUpdateSuggestion")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Fans one sync run out into a suggestion per project on that repository and branch.
   *
   * `(project_id, upstream_sync_run_id)` is unique, so a re-run of the upkeep job for a run that
   * already fanned out adds nothing rather than duplicating every card in the UI.
   */
  async function fanOut(input: {
    upstreamSyncRunId: string
    projectIds: readonly string[]
    summary: string | null
  }): Promise<number> {
    if (input.projectIds.length === 0) return 0

    const rows = await db
      .insertInto("projectUpdateSuggestion")
      .values(
        input.projectIds.map((projectId) => ({
          id: v7(),
          projectId,
          upstreamSyncRunId: input.upstreamSyncRunId,
          summary: input.summary,
          status: "pending",
        })),
      )
      .onConflict((oc) => oc.columns(["projectId", "upstreamSyncRunId"]).doNothing())
      .returning("id")
      .execute()

    return rows.length
  }

  /**
   * Resolves a suggestion, conditional on it still being pending.
   *
   * Two people clicking "update" on the same card is ordinary, and the conditional update is what
   * makes the second click a no-op instead of a second pull request.
   */
  async function resolve(input: {
    projectId: string
    id: string
    status: SuggestionStatus
    userId: string
  }): Promise<Selectable<DB["projectUpdateSuggestion"]> | undefined> {
    return await db
      .updateTable("projectUpdateSuggestion")
      .set({
        status: input.status,
        resolvedByUserId: input.userId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", input.id)
      .where("projectId", "=", input.projectId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst()
  }

  return { create, fanOut, resolve }
}
