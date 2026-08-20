import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export type RoleStatementRow = {
  id: string
  effect: string
  actions: string[]
  resources: string[]
}

export function fetchRole(db: Kysely<DB>) {
  /**
   * A role by id, scoped to the organization it must belong to.
   *
   * Every read here takes the organization id even though `role.id` is unique, because the caller
   * is authorized against one organization and a role id from another one must resolve to nothing
   * rather than to a role they can then edit.
   */
  async function getInOrganization<T extends (keyof DB["role"])[]>(
    organizationId: string,
    roleId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["role"]>, T[number]> | undefined> {
    return await db
      .selectFrom("role")
      .select(fields)
      .where("id", "=", roleId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function getByName<T extends (keyof DB["role"])[]>(
    organizationId: string,
    name: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["role"]>, T[number]> | undefined> {
    return await db
      .selectFrom("role")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("name", "=", name)
      .executeTakeFirst()
  }

  function listQuery(organizationId: string) {
    return db
      .selectFrom("role")
      .where("organizationId", "=", organizationId)
      .select(["id", "name", "description", "isSystem", "createdAt"])
      .orderBy("id", "desc")
  }

  async function listStatements(roleIds: readonly string[]) {
    if (roleIds.length === 0) return []

    return await db
      .selectFrom("roleStatement")
      .where("roleId", "in", [...roleIds])
      .select(["id", "roleId", "effect", "actions", "resources"])
      .orderBy("id", "asc")
      .execute()
  }

  /** Whether any membership still holds this role, which is what makes a delete safe. */
  async function countAssignments(roleId: string): Promise<number> {
    const row = await db
      .selectFrom("memberRole")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("roleId", "=", roleId)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  /** Whether any pending invite still points at this role. `organization_invite` RESTRICTs. */
  async function countPendingInvites(roleId: string): Promise<number> {
    const row = await db
      .selectFrom("organizationInvite")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("roleId", "=", roleId)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return {
    countAssignments,
    countPendingInvites,
    getByName,
    getInOrganization,
    listQuery,
    listStatements,
  }
}
