import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export function crudUserPreference(db: Kysely<DB>) {
  /**
   * Records which organization the user was last in, which is where `/dashboard` redirects to
   * (ADR 0004). Upserts because the row is created lazily — a user who never changed a preference
   * still needs somewhere to put this.
   */
  async function setLastOrganization(
    userId: string,
    lastOrgId: string | null,
  ): Promise<Selectable<DB["userPreference"]>> {
    return await db
      .insertInto("userPreference")
      .values({ id: v7(), userId, lastOrgId })
      .onConflict((oc) => oc.column("userId").doUpdateSet({ lastOrgId, updatedAt: new Date() }))
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { setLastOrganization }
}
