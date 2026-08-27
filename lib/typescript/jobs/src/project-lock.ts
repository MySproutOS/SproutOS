import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"

export class ProjectBusyError extends Error {
  constructor(projectId: string) {
    super(`Another operation is already changing project ${projectId}`)
    this.name = "ProjectBusyError"
  }
}

/** Serialize every operation that changes what a project serves. */
export async function withProjectLock<T>(
  db: Kysely<DB>,
  projectId: string,
  work: () => Promise<T>,
  options: { keepAlive?: () => Promise<boolean>; maxWaitMs?: number } = {},
): Promise<T> {
  return db.connection().execute(async (connection) => {
    const key = `sproutos:project:${projectId}`
    const startedAt = Date.now()
    for (;;) {
      const result = await sql<{ acquired: boolean }>`
        select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired
      `.execute(connection)
      if (result.rows[0]?.acquired) break
      if (Date.now() - startedAt >= (options.maxWaitMs ?? 30 * 60_000)) {
        throw new ProjectBusyError(projectId)
      }
      if (options.keepAlive !== undefined && !(await options.keepAlive())) {
        throw new Error(`Lost ownership of the job while waiting for project ${projectId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    try {
      return await work()
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection)
    }
  })
}
