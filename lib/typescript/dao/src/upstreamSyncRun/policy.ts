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

export type UpkeepOutcome = "up_to_date" | "pr_opened" | "merged" | "conflict" | "failed"

export type UpkeepStatus = {
  consecutiveFailures: number
  paused: boolean
  lastOutcome: UpkeepOutcome | null
  lastRunAt: Date | null
}

export type AutoUpdateCadence =
  | "one_day"
  | "two_days"
  | "one_week"
  | "one_month"
  | "three_months"
  | "six_months"
  | "nine_months"
  | "one_year"
  | "two_years"

const DAY_MS = 24 * 60 * 60 * 1000
const CADENCE_MS: Record<AutoUpdateCadence, number> = {
  one_day: DAY_MS,
  two_days: 2 * DAY_MS,
  one_week: 7 * DAY_MS,
  one_month: 30 * DAY_MS,
  three_months: 90 * DAY_MS,
  six_months: 180 * DAY_MS,
  nine_months: 270 * DAY_MS,
  one_year: 365 * DAY_MS,
  two_years: 730 * DAY_MS,
}

/** A missed interval remains due until a run is recorded, so worker downtime is caught up. */
export function cadenceIsDue(
  cadence: AutoUpdateCadence,
  lastRunAt: Date | null,
  now: Date,
): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= CADENCE_MS[cadence]
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
      .select(["outcome", "createdAt"])
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
      lastRunAt: runs[0]?.createdAt ?? null,
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
  async function dueForUpkeep(
    now: Date = new Date(),
    limit = 200,
  ): Promise<{ id: string; organizationId: string }[]> {
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
      if (status.paused) continue

      const cadenceRows = await db
        .selectFrom("project")
        .select("autoUpdateCadence")
        .distinct()
        .where("repositoryId", "=", candidate.id)
        .where("autoUpdateEnabled", "=", true)
        .where("deletedAt", "is", null)
        .execute()
      const cadences = cadenceRows.map((row) => row.autoUpdateCadence as AutoUpdateCadence)

      if (cadences.some((cadence) => cadenceIsDue(cadence, status.lastRunAt, now))) {
        due.push({
          id: candidate.id,
          organizationId: candidate.organizationId,
        })
      }
    }
    return due
  }

  return { dueForUpkeep, forRepository }
}
