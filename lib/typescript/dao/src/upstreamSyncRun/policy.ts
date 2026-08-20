import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"

/**
 * How many failures in a row stop a repository's scheduled upkeep.
 *
 * Upkeep costs money on every run — a metered credential pays per token, and even a subscription
 * pays in wall-clock on a runner. A fork whose upstream has diverged past reconciliation will fail
 * identically every night forever, so the loop has to end somewhere.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 5

export type UpkeepOutcome = "up_to_date" | "pr_opened" | "conflict" | "failed"

export type UpkeepStatus = {
  consecutiveFailures: number
  paused: boolean
  lastOutcome: UpkeepOutcome | null
}

/**
 * Whether a repository's upkeep is paused, derived from its own history.
 *
 * Deliberately not a `consecutive_failures` column. A counter is a second copy of something
 * `upstream_sync_run` already records, and the two disagree the first time a run is recorded by a
 * path that forgets to bump it — at which point the honest answer is in the history and the
 * counter is a lie that stops a customer's updates.
 *
 * A `conflict` is not a failure. It means upstream and the fork both changed the same lines, which
 * is the normal state of a fork someone is actually working on; it produces a pull request a person
 * resolves. Counting it would pause exactly the repositories that are being used.
 */
export function fetchUpkeepStatus(db: Kysely<DB> | Transaction<DB>) {
  async function forRepository(repositoryId: string): Promise<UpkeepStatus> {
    const runs = await db
      .selectFrom("upstreamSyncRun")
      .select("outcome")
      .where("repositoryId", "=", repositoryId)
      .orderBy("createdAt", "desc")
      .limit(CONSECUTIVE_FAILURE_LIMIT)
      .execute()

    let consecutiveFailures = 0
    for (const run of runs) {
      if (run.outcome !== "failed") break
      consecutiveFailures += 1
    }

    return {
      consecutiveFailures,
      paused: consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT,
      lastOutcome: (runs[0]?.outcome as UpkeepOutcome | undefined) ?? null,
    }
  }

  /**
   * Repositories with at least one project asking for upkeep, that are forks of something, and
   * whose upkeep is not paused.
   *
   * One row per *repository*, not per project: TASK 21 allows several projects to share a
   * repository, and reconciling the same fork three times because three projects point at it
   * would bill three times for one piece of work.
   */
  async function dueForUpkeep(limit = 200): Promise<{ id: string; organizationId: string }[]> {
    const candidates = await db
      .selectFrom("repository")
      .select(["repository.id as id", "repository.organizationId as organizationId"])
      .where("repository.deletedAt", "is", null)
      .where("repository.upstreamFullName", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("project")
            .select("project.id")
            .whereRef("project.repositoryId", "=", "repository.id")
            .where("project.autoUpdateEnabled", "=", true)
            .where("project.deletedAt", "is", null),
        ),
      )
      .orderBy("repository.id", "asc")
      .limit(limit)
      .execute()

    const due: { id: string; organizationId: string }[] = []
    for (const candidate of candidates) {
      const status = await forRepository(candidate.id)
      if (!status.paused) due.push(candidate)
    }
    return due
  }

  return { dueForUpkeep, forRepository }
}
