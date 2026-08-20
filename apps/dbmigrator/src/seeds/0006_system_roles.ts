// The per-organization rebuild is a read-modify-write chain, so the writes stay serial.
/* oxlint-disable no-await-in-loop */
import type { Kysely } from "kysely"
import { type Row, asRow, asRows, text } from "../lib/rows"
import { SYSTEM_ROLES, orgScopedResource } from "../lib/system-roles"
import { uuidV7 } from "../lib/uuid"

/**
 * Idempotent backfill: every organization gets the three system roles, the owner's membership
 * holds `owner`, and `member_permission` is rebuilt from `member_role` x `role_statement` for
 * that organization. Safe to re-run after editing `../lib/system-roles.ts`.
 */
export async function seed(db: Kysely<any>): Promise<void> {
  const organizations = asRows(
    await db
      .selectFrom("organization")
      .select(["id", "ownerUserId"])
      .where("deleted_at", "is", null)
      .execute(),
  )

  for (const organization of organizations) {
    const organizationId = text(organization, "id")
    const ownerUserId = text(organization, "ownerUserId")
    const resources = [orgScopedResource(organizationId)]
    const roleIdByName = new Map<string, string>()

    for (const definition of SYSTEM_ROLES) {
      const existing = asRow(
        await db
          .selectFrom("role")
          .select(["id"])
          .where("organization_id", "=", organizationId)
          .where("name", "=", definition.name)
          .executeTakeFirst(),
      )

      const roleId = existing ? text(existing, "id") : uuidV7()
      roleIdByName.set(definition.name, roleId)

      if (existing) {
        await db
          .updateTable("role")
          .set({ description: definition.description, is_system: true, updated_at: new Date() })
          .where("id", "=", roleId)
          .execute()
        await db.deleteFrom("role_statement").where("role_id", "=", roleId).execute()
      } else {
        await db
          .insertInto("role")
          .values({
            id: roleId,
            organization_id: organizationId,
            name: definition.name,
            description: definition.description,
            is_system: true,
          })
          .execute()
      }

      await db
        .insertInto("role_statement")
        .values(
          definition.statements.map((statement) => ({
            id: uuidV7(),
            role_id: roleId,
            effect: statement.effect,
            actions: statement.actions,
            resources,
          })),
        )
        .execute()
    }

    const existingMembership = asRow(
      await db
        .selectFrom("organization_member")
        .select(["id"])
        .where("organization_id", "=", organizationId)
        .where("user_id", "=", ownerUserId)
        .executeTakeFirst(),
    )

    const ownerMembershipId = existingMembership ? text(existingMembership, "id") : uuidV7()

    if (!existingMembership) {
      await db
        .insertInto("organization_member")
        .values({
          id: ownerMembershipId,
          organization_id: organizationId,
          user_id: ownerUserId,
          status: "active",
        })
        .execute()
    }

    const ownerRoleId = roleIdByName.get("owner")

    if (ownerRoleId) {
      await db
        .insertInto("member_role")
        .values({
          id: uuidV7(),
          organization_member_id: ownerMembershipId,
          role_id: ownerRoleId,
        })
        .onConflict((oc) => oc.columns(["organization_member_id", "role_id"]).doNothing())
        .execute()
    }

    await db.deleteFrom("member_permission").where("organization_id", "=", organizationId).execute()

    const grants = asRows(
      await db
        .selectFrom("member_role")
        .innerJoin(
          "organization_member",
          "organization_member.id",
          "member_role.organization_member_id",
        )
        .innerJoin("role_statement", "role_statement.role_id", "member_role.role_id")
        .where("organization_member.organization_id", "=", organizationId)
        .select([
          "member_role.id as memberRoleId",
          "organization_member.user_id as userId",
          "role_statement.effect as effect",
          "role_statement.actions as actions",
          "role_statement.resources as resources",
        ])
        .execute(),
    )

    if (grants.length > 0) {
      await db
        .insertInto("member_permission")
        .values(
          grants.map((grant: Row) => ({
            id: uuidV7(),
            organization_id: organizationId,
            user_id: text(grant, "userId"),
            member_role_id: text(grant, "memberRoleId"),
            effect: text(grant, "effect"),
            actions: grant.actions,
            resources: grant.resources,
          })),
        )
        .execute()
    }
  }
}
