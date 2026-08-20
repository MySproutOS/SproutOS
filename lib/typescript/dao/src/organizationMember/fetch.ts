import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export type MembershipRow = {
  id: string
  organizationId: string
  userId: string
  status: string
}

export function fetchOrganizationMember(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["organizationMember"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["organizationMember"]>, T[number]> | undefined> {
    return await db
      .selectFrom("organizationMember")
      .select(fields)
      .where("id", "=", id)
      .executeTakeFirst()
  }

  /**
   * The membership row for one user in one organization.
   *
   * Scoped by `organization_id` as well as `id` wherever a caller has both, so a member id
   * belonging to a different organization cannot be acted on from inside this one.
   */
  async function getInOrganization(
    organizationId: string,
    memberId: string,
  ): Promise<MembershipRow | undefined> {
    return await db
      .selectFrom("organizationMember")
      .select(["id", "organizationId", "userId", "status"])
      .where("id", "=", memberId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function getForUser(
    organizationId: string,
    userId: string,
  ): Promise<MembershipRow | undefined> {
    return await db
      .selectFrom("organizationMember")
      .select(["id", "organizationId", "userId", "status"])
      .where("organizationId", "=", organizationId)
      .where("userId", "=", userId)
      .executeTakeFirst()
  }

  function listQuery(organizationId: string) {
    return db
      .selectFrom("organizationMember")
      .innerJoin("user", "user.id", "organizationMember.userId")
      .where("organizationMember.organizationId", "=", organizationId)
      .select([
        "organizationMember.id as id",
        "organizationMember.userId as userId",
        "organizationMember.status as status",
        "organizationMember.createdAt as createdAt",
        "user.name as name",
        "user.email as email",
      ])
      .orderBy("organizationMember.id", "desc")
  }

  /** The role names each of these memberships holds, as one query rather than one per member. */
  async function listRolesForMembers(
    memberIds: readonly string[],
  ): Promise<{ organizationMemberId: string; roleId: string; name: string }[]> {
    if (memberIds.length === 0) return []

    return await db
      .selectFrom("memberRole")
      .innerJoin("role", "role.id", "memberRole.roleId")
      .where("memberRole.organizationMemberId", "in", [...memberIds])
      .select([
        "memberRole.organizationMemberId as organizationMemberId",
        "role.id as roleId",
        "role.name as name",
      ])
      .execute()
  }

  /**
   * The roles one user holds, across several organizations at once.
   *
   * For the organization *list*, where the caller's own role is what labels each row. Written as
   * one query over every organization on the page rather than a correlated subquery per row,
   * because a member may hold more than one role and a subquery that returns several rows is not a
   * subquery — the fan-out has to be grouped somewhere, and grouping it in the caller keeps the
   * query plan a plain join.
   */
  async function listRolesForUserInOrganizations(
    userId: string,
    organizationIds: readonly string[],
  ): Promise<{ organizationId: string; roleId: string; name: string }[]> {
    if (organizationIds.length === 0) return []

    return await db
      .selectFrom("memberRole")
      .innerJoin("role", "role.id", "memberRole.roleId")
      .innerJoin("organizationMember", "organizationMember.id", "memberRole.organizationMemberId")
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.organizationId", "in", [...organizationIds])
      // Roles are per-organization, so a role row already belongs to exactly one of them — but the
      // membership is what ties it to *this* user, and without that filter this would return every
      // member's roles for every organization on the page.
      .select([
        "organizationMember.organizationId as organizationId",
        "role.id as roleId",
        "role.name as name",
      ])
      .execute()
  }

  async function countActive(organizationId: string): Promise<number> {
    const row = await db
      .selectFrom("organizationMember")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organizationId", "=", organizationId)
      .where("status", "=", "active")
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return {
    countActive,
    getForUser,
    getInOrganization,
    getOne,
    listQuery,
    listRolesForMembers,
    listRolesForUserInOrganizations,
  }
}
