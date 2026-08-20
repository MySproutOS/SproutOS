import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

export function crudMemberPermission(db: Kysely<DB>) {
  /**
   * Rebuilds the whole denormalization for one organization from `member_role` x `role_statement`.
   *
   * Must run inside the same transaction as whatever changed. `member_permission.member_role_id`
   * cascades on delete, so revoking a role assignment cleans up on its own — but editing a
   * statement's actions or resources touches no `member_role` row at all, and without this call
   * the stale copy keeps authorizing. Rebuilding the organization rather than the single member
   * keeps one code path: a statement edit fans out to every member holding that role anyway.
   *
   * Suspended members keep their rows on purpose. Membership status is enforced when the caller is
   * resolved, so the denormalization stays a pure function of the role graph and reactivating a
   * member does not depend on a rebuild having run.
   */
  async function rebuildOrganization(organizationId: string): Promise<number> {
    await db.deleteFrom("memberPermission").where("organizationId", "=", organizationId).execute()

    const grants = await db
      .selectFrom("memberRole")
      .innerJoin("organizationMember", "organizationMember.id", "memberRole.organizationMemberId")
      .innerJoin("roleStatement", "roleStatement.roleId", "memberRole.roleId")
      .where("organizationMember.organizationId", "=", organizationId)
      .select([
        "memberRole.id as memberRoleId",
        "organizationMember.userId as userId",
        "roleStatement.effect as effect",
        "roleStatement.actions as actions",
        "roleStatement.resources as resources",
      ])
      .execute()

    if (grants.length === 0) return 0

    await db
      .insertInto("memberPermission")
      .values(
        grants.map((grant) => ({
          id: v7(),
          organizationId,
          userId: grant.userId,
          memberRoleId: grant.memberRoleId,
          effect: grant.effect,
          actions: grant.actions,
          resources: grant.resources,
        })),
      )
      .execute()

    return grants.length
  }

  return { rebuildOrganization }
}
