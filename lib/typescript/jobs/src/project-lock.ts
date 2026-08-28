/* oxlint-disable no-await-in-loop -- advisory-lock polling and lease renewal are sequential */
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"

export class ProjectBusyError extends Error {
  constructor(projectId: string) {
    super(`Another operation is already changing project ${projectId}`)
    this.name = "ProjectBusyError"
  }
}

type ProjectLockWaitOptions = {
  keepAlive?: () => Promise<boolean>
  maxWaitMs?: number
  /** Deterministic test seam; production waits one second between provider-safe reads. */
  waitBeforeRetry?: () => Promise<void>
  now?: () => number
}

/** Poll one exact advisory lock while retaining the queue lease. */
export async function waitForProjectLock(
  projectId: string,
  attemptAcquire: () => Promise<boolean>,
  options: ProjectLockWaitOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now
  const startedAt = now()
  for (;;) {
    if (await attemptAcquire()) return
    if (now() - startedAt >= (options.maxWaitMs ?? 30 * 60_000)) {
      throw new ProjectBusyError(projectId)
    }
    if (options.keepAlive !== undefined && !(await options.keepAlive())) {
      throw new Error(`Lost ownership of the job while waiting for project ${projectId}`)
    }
    await (options.waitBeforeRetry?.() ?? new Promise((resolve) => setTimeout(resolve, 1_000)))
  }
}

/** Serialize every operation that changes what a project serves. */
export async function withProjectLock<T>(
  db: Kysely<DB>,
  projectId: string,
  work: () => Promise<T>,
  options: ProjectLockWaitOptions = {},
): Promise<T> {
  return db.connection().execute(async (connection) => {
    const key = `sproutos:project:${projectId}`
    await waitForProjectLock(
      projectId,
      async () => {
        const result = await sql<{ acquired: boolean }>`
          select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
        `.execute(connection)
        return result.rows[0]?.acquired ?? false
      },
      options,
    )

    try {
      return await work()
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection)
    }
  })
}
