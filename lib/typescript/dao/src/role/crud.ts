import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export type StatementInput = {
  effect: "allow" | "deny"
  actions: string[]
  resources: string[]
}

export function crudRole(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["role"]>, "id">,
  ): Promise<Selectable<DB["role"]>> {
    return await db
      .insertInto("role")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    organizationId: string,
    roleId: string,
    data: Updateable<DB["role"]>,
  ): Promise<Selectable<DB["role"]> | undefined> {
    return await db
      .updateTable("role")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", roleId)
      .where("organizationId", "=", organizationId)
      .returningAll()
      .executeTakeFirst()
  }

  async function remove(organizationId: string, roleId: string): Promise<boolean> {
    const result = await db
      .deleteFrom("role")
      .where("id", "=", roleId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  /**
   * Replaces a role's whole statement set.
   *
   * The caller must rebuild `member_permission` in the same transaction. Nothing else will:
   * `member_permission.member_role_id` cascades on delete, which covers a revoked assignment, but
   * editing a statement in place leaves every assignment row untouched and every denormalized
   * copy stale. That stale copy is what authorizes requests, so skipping the rebuild silently
   * keeps the old permissions live.
   */
  async function replaceStatements(
    roleId: string,
    statements: readonly StatementInput[],
  ): Promise<void> {
    await db.deleteFrom("roleStatement").where("roleId", "=", roleId).execute()
    if (statements.length === 0) return

    await db
      .insertInto("roleStatement")
      .values(
        statements.map((statement) => ({
          id: v7(),
          roleId,
          effect: statement.effect,
          actions: statement.actions,
          resources: statement.resources,
        })),
      )
      .execute()
  }

  return { create, remove, replaceStatements, update }
}
