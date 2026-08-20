import type { DB } from "@sproutos/db"
import { organizationScopeSrn, srnFor } from "@lib/srn"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"
import { crudAuditLog } from "../auditLog/crud"
import { crudMemberPermission } from "../memberPermission/crud"
import { OWNER_ROLE_NAME, SYSTEM_ROLES } from "../role/systemRoles"
import { allocateOrganizationSlug, slugifyOrganizationName } from "./slug"

/** Request context an audit row wants but the database cannot know. */
export type AuditContext = {
  ip?: string | null
  userAgent?: string | null
}

export type ProvisionedOrganization = {
  id: string
  slug: string
  name: string
  kind: string
  created: boolean
}

/**
 * Seeds the three system roles into a fresh organization and returns their ids by name.
 *
 * The definitions come from `../role/systemRoles.ts`, which is the runtime twin of the migrator's
 * seed — an organization created here and one backfilled by `0006_system_roles` must end up with
 * byte-identical statements, or a team's authority would depend on when it was created.
 */
export async function seedSystemRoles(
  tx: Transaction<DB>,
  organizationId: string,
): Promise<Map<string, string>> {
  const roleIdByName = new Map<string, string>()
  const resources = [organizationScopeSrn(organizationId)]

  const roleRows = SYSTEM_ROLES.map((definition) => {
    const id = v7()
    roleIdByName.set(definition.name, id)
    return {
      id,
      organizationId,
      name: definition.name,
      description: definition.description,
      isSystem: true,
    }
  })

  await tx.insertInto("role").values(roleRows).execute()

  const statementRows = SYSTEM_ROLES.flatMap((definition) =>
    definition.statements.map((statement) => ({
      id: v7(),
      roleId: roleIdByName.get(definition.name) ?? "",
      effect: statement.effect,
      actions: statement.actions,
      resources,
    })),
  )

  await tx.insertInto("roleStatement").values(statementRows).execute()

  return roleIdByName
}

/**
 * Organization lifecycle operations that span several tables.
 *
 * Every function here opens its own transaction and must therefore be handed the pool, not a
 * transaction handle. Each writes its `audit_log` row inside that transaction: an audit trail
 * that can commit separately from the change it describes is worse than none, because it looks
 * authoritative.
 */
export function provisionOrganization(db: Kysely<DB>) {
  async function createInTransaction(
    tx: Transaction<DB>,
    input: {
      userId: string
      name: string
      slug: string
      kind: "personal" | "team"
      audit?: AuditContext
    },
  ): Promise<ProvisionedOrganization> {
    const organization = await tx
      .insertInto("organization")
      .values({
        id: v7(),
        slug: input.slug,
        name: input.name,
        kind: input.kind,
        ownerUserId: input.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const roleIdByName = await seedSystemRoles(tx, organization.id)

    const membership = await tx
      .insertInto("organizationMember")
      .values({
        id: v7(),
        organizationId: organization.id,
        userId: input.userId,
        status: "active",
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const ownerRoleId = roleIdByName.get(OWNER_ROLE_NAME)
    if (ownerRoleId === undefined) {
      throw new Error("system roles are missing the owner role")
    }

    await tx
      .insertInto("memberRole")
      .values({ id: v7(), organizationMemberId: membership.id, roleId: ownerRoleId })
      .execute()

    await crudMemberPermission(tx).rebuildOrganization(organization.id)

    await tx
      .insertInto("userPreference")
      .values({ id: v7(), userId: input.userId, lastOrgId: organization.id })
      .onConflict((oc) =>
        oc.column("userId").doUpdateSet({ lastOrgId: organization.id, updatedAt: new Date() }),
      )
      .execute()

    await crudAuditLog(tx).record({
      organizationId: organization.id,
      actorUserId: input.userId,
      action: "org:create",
      resourceSrn: srnFor("org", organization.id, "organization", organization.id),
      after: {
        slug: organization.slug,
        name: organization.name,
        kind: organization.kind,
        ownerUserId: organization.ownerUserId,
      },
      ip: input.audit?.ip,
      userAgent: input.audit?.userAgent,
    })

    return {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      kind: organization.kind,
      created: true,
    }
  }

  /**
   * Creates an additional organization for a user (TASK 14). There is no cap on how many.
   *
   * `slug` is a suggestion. It is normalized and disambiguated rather than rejected, because the
   * uniqueness index is partial on `deleted_at IS NULL` and a slug freed by a deletion should be
   * usable again without the caller having to know that.
   */
  async function createOrganization(input: {
    userId: string
    name: string
    slug?: string | null
    kind?: "personal" | "team"
    audit?: AuditContext
  }): Promise<ProvisionedOrganization> {
    const desired = input.slug ?? slugifyOrganizationName(input.name)
    const slug = await allocateOrganizationSlug(db, desired)

    return await db.transaction().execute(
      async (tx) =>
        await createInTransaction(tx, {
          userId: input.userId,
          name: input.name,
          slug,
          kind: input.kind ?? "team",
          audit: input.audit,
        }),
    )
  }

  /**
   * Places a user in a default organization named `"<Name>'s Team"` at first sign-in (TASK 10).
   *
   * Idempotent and cheap to call on every sign-in: a user who already belongs to any live
   * organization gets that one back with `created: false`, and no rows are written. This is the
   * function the OAuth callback calls; it must not be folded into the callback itself, because
   * the same provisioning has to run for every future sign-in path.
   */
  async function ensureDefaultOrganization(input: {
    userId: string
    name?: string | null
    email?: string | null
    audit?: AuditContext
  }): Promise<ProvisionedOrganization> {
    const existing = await db
      .selectFrom("organizationMember")
      .innerJoin("organization", "organization.id", "organizationMember.organizationId")
      .where("organizationMember.userId", "=", input.userId)
      .where("organizationMember.status", "=", "active")
      .where("organization.deletedAt", "is", null)
      .select([
        "organization.id as id",
        "organization.slug as slug",
        "organization.name as name",
        "organization.kind as kind",
      ])
      .orderBy("organization.id", "asc")
      .executeTakeFirst()

    if (existing) {
      return { ...existing, created: false }
    }

    const displayName = (input.name ?? "").trim() || (input.email ?? "").split("@")[0] || "My"
    const name = `${displayName}'s Team`
    const slug = await allocateOrganizationSlug(db, slugifyOrganizationName(name))

    return await db.transaction().execute(
      async (tx) =>
        await createInTransaction(tx, {
          userId: input.userId,
          name,
          slug,
          kind: "personal",
          audit: input.audit,
        }),
    )
  }

  /**
   * Hands an organization to another member (TASK 32).
   *
   * The new owner must already be an active member: promoting a stranger would mean creating a
   * membership as a side effect of a transfer, and an owner who is not in the member list is a
   * state no screen in the product can show. The outgoing owner is demoted to `admin` rather than
   * removed, because dropping them entirely would leave an organization whose creator cannot see
   * it, and `admin` is exactly "everything except transferring it again".
   */
  async function transferOwnership(input: {
    organizationId: string
    actorUserId: string
    newOwnerUserId: string
    audit?: AuditContext
  }): Promise<{ ok: true } | { ok: false; reason: "not-a-member" | "already-owner" | "gone" }> {
    return await db.transaction().execute(async (tx) => {
      const organization = await tx
        .selectFrom("organization")
        .select(["id", "ownerUserId", "slug", "name"])
        .where("id", "=", input.organizationId)
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst()

      if (!organization) return { ok: false as const, reason: "gone" as const }
      if (organization.ownerUserId === input.newOwnerUserId) {
        return { ok: false as const, reason: "already-owner" as const }
      }

      const incoming = await tx
        .selectFrom("organizationMember")
        .select(["id", "userId"])
        .where("organizationId", "=", input.organizationId)
        .where("userId", "=", input.newOwnerUserId)
        .where("status", "=", "active")
        .executeTakeFirst()

      if (!incoming) return { ok: false as const, reason: "not-a-member" as const }

      const roles = await tx
        .selectFrom("role")
        .select(["id", "name"])
        .where("organizationId", "=", input.organizationId)
        .where("isSystem", "=", true)
        .execute()

      const ownerRoleId = roles.find((role) => role.name === "owner")?.id
      const adminRoleId = roles.find((role) => role.name === "admin")?.id

      const outgoing = await tx
        .selectFrom("organizationMember")
        .select(["id"])
        .where("organizationId", "=", input.organizationId)
        .where("userId", "=", organization.ownerUserId)
        .executeTakeFirst()

      await tx
        .updateTable("organization")
        .set({ ownerUserId: input.newOwnerUserId, updatedAt: new Date() })
        .where("id", "=", input.organizationId)
        .execute()

      if (ownerRoleId !== undefined) {
        await tx
          .insertInto("memberRole")
          .values({ id: v7(), organizationMemberId: incoming.id, roleId: ownerRoleId })
          .onConflict((oc) => oc.columns(["organizationMemberId", "roleId"]).doNothing())
          .execute()

        if (outgoing) {
          await tx
            .deleteFrom("memberRole")
            .where("organizationMemberId", "=", outgoing.id)
            .where("roleId", "=", ownerRoleId)
            .execute()

          if (adminRoleId !== undefined) {
            await tx
              .insertInto("memberRole")
              .values({ id: v7(), organizationMemberId: outgoing.id, roleId: adminRoleId })
              .onConflict((oc) => oc.columns(["organizationMemberId", "roleId"]).doNothing())
              .execute()
          }
        }
      }

      await crudMemberPermission(tx).rebuildOrganization(input.organizationId)

      await crudAuditLog(tx).record({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "org:transfer_ownership",
        resourceSrn: srnFor("org", input.organizationId, "organization", input.organizationId),
        before: { ownerUserId: organization.ownerUserId },
        after: { ownerUserId: input.newOwnerUserId },
        ip: input.audit?.ip,
        userAgent: input.audit?.userAgent,
      })

      return { ok: true as const }
    })
  }

  return { createOrganization, ensureDefaultOrganization, transferOwnership }
}
