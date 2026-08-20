import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudOrganizationInvite(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["organizationInvite"]>, "id">,
  ): Promise<Selectable<DB["organizationInvite"]>> {
    return await db
      .insertInto("organizationInvite")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Marks an invite accepted, but only if it is still pending.
   *
   * The predicates are the redemption check, not a convenience: two concurrent redemptions of the
   * same token both read a pending row, and the one that loses this conditional update gets
   * `undefined` and must not create a second membership.
   */
  async function markAccepted(
    inviteId: string,
  ): Promise<Selectable<DB["organizationInvite"]> | undefined> {
    return await db
      .updateTable("organizationInvite")
      .set({ acceptedAt: new Date() })
      .where("id", "=", inviteId)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  async function revoke(
    organizationId: string,
    inviteId: string,
  ): Promise<Selectable<DB["organizationInvite"]> | undefined> {
    return await db
      .updateTable("organizationInvite")
      .set({ revokedAt: new Date() })
      .where("id", "=", inviteId)
      .where("organizationId", "=", organizationId)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, markAccepted, revoke }
}
