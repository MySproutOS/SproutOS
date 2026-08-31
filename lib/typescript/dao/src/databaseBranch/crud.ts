import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { sql } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudDatabaseBranch(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["databaseBranch"]>, "id">,
  ): Promise<Selectable<DB["databaseBranch"]>> {
    return await db
      .insertInto("databaseBranch")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function deferCleanup(id: string, error: unknown): Promise<void> {
    await db
      .updateTable("databaseBranch")
      .set({
        cleanupAttempts: sql<number>`cleanup_attempts + 1`,
        cleanupError: String(error).slice(0, 2_000),
        cleanupRetryAt: sql<Date>`now() + make_interval(secs => least(3600, 30 * power(2, cleanup_attempts)))`,
        // Default sandbox branches normally have no expiry. Once provider cleanup fails they must
        // also become visible to the independent branch reaper, not only to sandbox reconciliation.
        expiresAt: sql<Date>`coalesce(expires_at, now())`,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .execute()
  }

  return { create, deferCleanup }
}
