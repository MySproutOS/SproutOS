import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudRetentionNoticeDelivery(db: Kysely<DB>) {
  async function createOnce(
    data: PartialBy<Insertable<DB["retentionNoticeDelivery"]>, "id">,
  ): Promise<Selectable<DB["retentionNoticeDelivery"]> | undefined> {
    return await db
      .insertInto("retentionNoticeDelivery")
      .values({ id: v7(), ...data })
      .onConflict((conflict) =>
        conflict.columns(["organizationId", "generation", "stage", "recipient"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst()
  }

  async function markSent(id: string): Promise<void> {
    await db
      .updateTable("retentionNoticeDelivery")
      .set({ status: "sent", sentAt: new Date(), lastError: null, updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  async function markFailed(id: string, error: string): Promise<void> {
    await db
      .updateTable("retentionNoticeDelivery")
      .set({
        status: "failed",
        attempts: (eb) => eb("attempts", "+", 1),
        lastError: error,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .execute()
  }

  return { createOnce, markFailed, markSent }
}
