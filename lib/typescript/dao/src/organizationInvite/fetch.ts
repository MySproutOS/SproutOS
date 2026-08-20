import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchOrganizationInvite(db: Kysely<DB>) {
  /**
   * Looks an invite up by the hash of its token.
   *
   * The token itself is never stored, so a database leak yields nothing redeemable — the same
   * property `session` relies on. Pending-ness is checked by the caller rather than folded in
   * here, because "expired" and "already accepted" are different messages to the invitee.
   */
  async function getByTokenHash(
    tokenHash: string,
  ): Promise<Selectable<DB["organizationInvite"]> | undefined> {
    return await db
      .selectFrom("organizationInvite")
      .selectAll()
      .where("tokenHash", "=", tokenHash)
      .executeTakeFirst()
  }

  async function getInOrganization(
    organizationId: string,
    inviteId: string,
  ): Promise<Selectable<DB["organizationInvite"]> | undefined> {
    return await db
      .selectFrom("organizationInvite")
      .selectAll()
      .where("id", "=", inviteId)
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function getPendingForEmail(
    organizationId: string,
    email: string,
  ): Promise<Selectable<DB["organizationInvite"]> | undefined> {
    return await db
      .selectFrom("organizationInvite")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("email", "=", email)
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .executeTakeFirst()
  }

  function listPendingQuery(organizationId: string) {
    return db
      .selectFrom("organizationInvite")
      .innerJoin("role", "role.id", "organizationInvite.roleId")
      .where("organizationInvite.organizationId", "=", organizationId)
      .where("organizationInvite.acceptedAt", "is", null)
      .where("organizationInvite.revokedAt", "is", null)
      .select([
        "organizationInvite.id as id",
        "organizationInvite.email as email",
        "organizationInvite.expiresAt as expiresAt",
        "organizationInvite.createdAt as createdAt",
        "organizationInvite.invitedByUserId as invitedByUserId",
        "role.id as roleId",
        "role.name as roleName",
      ])
      .orderBy("organizationInvite.id", "desc")
  }

  return { getByTokenHash, getInOrganization, getPendingForEmail, listPendingQuery }
}
