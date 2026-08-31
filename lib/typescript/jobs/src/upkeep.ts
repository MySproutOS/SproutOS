import { fetchUpkeepStatus } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

export const UPKEEP_KINDS = {
  scan: "upkeep.scan",
  repository: "upkeep.repository",
} as const

/**
 * Find the repositories due for upkeep and enqueue one job each.
 *
 * A scan-then-fan-out rather than one enormous job, because a single job holding a lease while it
 * reconciles two hundred forks is two hundred failures riding on one lease. Per-repository jobs
 * retry, back off, and dead-letter independently.
 *
 * The idempotency key is the repository and the hour, so a scan that runs twice — a retry, an
 * overlapping worker, a redeployed pod — enqueues each repository once.
 */
export function scanForUpkeep(window: string): JobHandler {
  return async (_job, { db }) => {
    const due = await fetchUpkeepStatus(db).dueForUpkeep()

    for (const repository of due) {
      await enqueue(db, {
        kind: UPKEEP_KINDS.repository,
        organizationId: repository.organizationId,
        payload: { repositoryId: repository.id },
        idempotencyKey: `${UPKEEP_KINDS.repository}:${repository.id}:${window}`,
        // Two attempts, not five. A reconciliation that fails is usually going to keep failing,
        // and each attempt costs the customer tokens; the consecutive-failure rule is the real
        // circuit breaker and it counts *runs*, not attempts.
        maxAttempts: 2,
      })
    }

    if (due.length > 0) console.info(`[upkeep] scheduled ${due.length} repositories`)
  }
}

/**
 * Enqueue the hourly scan.
 *
 * Called from the worker's recurring scheduler. The hour is the key, so every worker can call it
 * and exactly one row exists.
 */
export async function scheduleUpkeepScan(db: Kysely<DB>, now: Date = new Date()): Promise<string> {
  const hour = now.toISOString().slice(0, 13)
  return await enqueue(db, {
    kind: UPKEEP_KINDS.scan,
    idempotencyKey: `${UPKEEP_KINDS.scan}:${hour}`,
    maxAttempts: 3,
  })
}
