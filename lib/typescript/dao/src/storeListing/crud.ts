import type { DB } from "@sproutos/db"
import { type Insertable, type Kysely, type Selectable, sql, type Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudStoreListing(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["storeListing"]>, "id">,
  ): Promise<Selectable<DB["storeListing"]>> {
    return await db
      .insertInto("storeListing")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["storeListing"]>,
  ): Promise<Selectable<DB["storeListing"]> | undefined> {
    return await db
      .updateTable("storeListing")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Moves a listing into `published` and records who decided that.
   *
   * `reviewed_by_user_id` and `reviewed_at` are set here rather than left to the caller because a
   * published listing with no reviewer is indistinguishable from one that was published by a bug,
   * and the store renders community-submitted markdown only once this has happened.
   */
  async function publish(
    id: string,
    reviewerUserId: string,
  ): Promise<Selectable<DB["storeListing"]> | undefined> {
    return await db
      .updateTable("storeListing")
      .set({
        status: "published",
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  async function unpublish(
    id: string,
    reviewerUserId: string,
    status: "archived" | "rejected",
    reason: string | null,
  ): Promise<Selectable<DB["storeListing"]> | undefined> {
    return await db
      .updateTable("storeListing")
      .set({
        status,
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Bumps the fork counter in SQL rather than read-modify-write, so two people forking the same
   * listing at once do not each write back the same number.
   */
  async function incrementInstallCount(id: string): Promise<void> {
    await db
      .updateTable("storeListing")
      .set({ installCount: sql`install_count + 1` })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .execute()
  }

  return { create, incrementInstallCount, publish, unpublish, update }
}
