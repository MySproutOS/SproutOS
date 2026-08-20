import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudOrganizationMember(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["organizationMember"]>, "id">,
  ): Promise<Selectable<DB["organizationMember"]>> {
    return await db
      .insertInto("organizationMember")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["organizationMember"]>,
  ): Promise<Selectable<DB["organizationMember"]> | undefined> {
    return await db
      .updateTable("organizationMember")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Removes a membership. Scoped by organization so a member id from elsewhere cannot be deleted
   * through an organization the caller does happen to administer.
   *
   * `member_role` and `member_permission` cascade from here, so the member's authority disappears
   * with the row and no rebuild is required.
   */
  async function remove(organizationId: string, memberId: string): Promise<boolean> {
    const result = await db
      .deleteFrom("organizationMember")
      .where("id", "=", memberId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  async function assignRole(organizationMemberId: string, roleId: string): Promise<void> {
    await db
      .insertInto("memberRole")
      .values({ id: v7(), organizationMemberId, roleId })
      .onConflict((oc) => oc.columns(["organizationMemberId", "roleId"]).doNothing())
      .execute()
  }

  async function clearRoles(organizationMemberId: string): Promise<void> {
    await db
      .deleteFrom("memberRole")
      .where("organizationMemberId", "=", organizationMemberId)
      .execute()
  }

  /** Replaces the member's whole role set. The caller rebuilds `member_permission` afterwards. */
  async function setRoles(organizationMemberId: string, roleIds: readonly string[]): Promise<void> {
    await clearRoles(organizationMemberId)
    if (roleIds.length === 0) return

    await db
      .insertInto("memberRole")
      .values(
        [...new Set(roleIds)].map((roleId) => ({
          id: v7(),
          organizationMemberId,
          roleId,
        })),
      )
      .execute()
  }

  return { assignRole, clearRoles, create, remove, setRoles, update }
}
