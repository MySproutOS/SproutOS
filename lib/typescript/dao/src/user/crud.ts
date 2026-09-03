import type { DB } from "@sproutos/db"
import type { Insertable } from "kysely"
import type { Kysely } from "kysely"
import type { PartialBy } from "../utils/types"
import { v7 } from "uuid"

export type DeleteUserOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  /** They still own organizations, named so the UI can tell them which. */
  | { ok: false; reason: "owns_organizations"; organizations: Array<{ id: string; slug: string }> }

export function crudUser(db: Kysely<DB>) {
  async function createUser(data: PartialBy<Insertable<DB["user"]>, "id">) {
    return await db
      .insertInto("user")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Closes an account.
   *
   * **Soft, and it could not be otherwise.** `audit_log.actor_user_id`, `api_key.user_id` and
   * `organization.owner_user_id` are all `ON DELETE RESTRICT`, so a `delete from "user"` fails for
   * anyone who has ever done anything — which is everyone. The previous implementation issued
   * exactly that delete inside a `try` that returned `false`, so closing an account reported a
   * failure it could not explain and changed nothing.
   *
   * Those RESTRICTs are right: an audit trail that loses its actor cannot answer the question it
   * exists for, and billing history whose customer vanished cannot be reconciled. Deletion has to
   * mean *the person is gone from the product*, not *the rows are gone from the database*.
   *
   * So this:
   *
   * - refuses while they still **own** an organization. Someone has to be responsible for a team's
   *   data and its bill, and silently orphaning or cascading it are both worse than saying so.
   *   Transfer it or delete it first.
   * - clears the personal data. `email` and `name` are what makes a row a person; the id that
   *   `audit_log` points at is not.
   * - revokes every way back in — sessions, API keys, OAuth grants — in the same transaction, so
   *   there is no window where the account is closed and a token still works.
   */
  async function deleteUser(userId: string): Promise<DeleteUserOutcome> {
    return await db.transaction().execute(async (tx) => {
      const begun = await beginDeletion(tx, userId)
      if (!begun.ok) return begun
      return completeDeletion(tx, userId)
    })
  }

  /** Disable every authentication path while durable provider cleanup is still running. */
  async function beginUserDeletion(userId: string): Promise<DeleteUserOutcome> {
    return beginDeletion(db, userId)
  }

  /** Strip the remaining identity only after every provider resource has been removed. */
  async function completeUserDeletion(userId: string): Promise<DeleteUserOutcome> {
    return db.transaction().execute((tx) => completeDeletion(tx, userId))
  }

  async function updateGithubIdentity(
    userId: string,
    identity: { githubLogin: string | null; githubUserId: bigint } | null,
  ) {
    return await db
      .updateTable("user")
      .set({
        githubLogin: identity === null ? null : identity.githubLogin,
        githubUserId: identity === null ? null : identity.githubUserId,
        updatedAt: new Date(),
      })
      .where("id", "=", userId)
      .returning(["id", "githubLogin", "githubUserId"])
      .executeTakeFirst()
  }

  return {
    beginUserDeletion,
    completeUserDeletion,
    createUser,
    deleteUser,
    updateGithubIdentity,
  }
}

async function activeOwnedOrganizations(db: Kysely<DB>, userId: string) {
  return db
    .selectFrom("organization")
    .select(["id", "slug"])
    .where("ownerUserId", "=", userId)
    .where("deletedAt", "is", null)
    .execute()
}

async function beginDeletion(db: Kysely<DB>, userId: string): Promise<DeleteUserOutcome> {
  const user = await db
    .selectFrom("user")
    .select(["id", "email"])
    .where("id", "=", userId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (user === undefined) return { ok: false, reason: "not_found" }

  const owned = await activeOwnedOrganizations(db, userId)
  if (owned.length > 0) {
    return { ok: false, reason: "owns_organizations", organizations: owned }
  }

  const now = new Date()
  await db
    .updateTable("user")
    .set({ deletedAt: now, updatedAt: now })
    .where("id", "=", userId)
    .execute()
  await revokeAndDetach(db, userId, user.email, now)
  return { ok: true }
}

async function completeDeletion(db: Kysely<DB>, userId: string): Promise<DeleteUserOutcome> {
  const user = await db
    .selectFrom("user")
    .select(["id", "email"])
    .where("id", "=", userId)
    .executeTakeFirst()
  if (user === undefined) return { ok: false, reason: "not_found" }

  const owned = await activeOwnedOrganizations(db, userId)
  if (owned.length > 0) {
    return { ok: false, reason: "owns_organizations", organizations: owned }
  }

  await anonymise(db, userId, user.email)
  return { ok: true }
}

/**
 * Strips the personal data and revokes everything that could authenticate.
 *
 * The email becomes `deleted+<id>@invalid`. Not null: `user.email` is `NOT NULL` and unique, and the
 * `.invalid` TLD is reserved by RFC 2606 precisely so it can never route — a tombstone that cannot
 * be mistaken for a live address and cannot collide with a real one.
 */
async function anonymise(tx: Kysely<DB>, userId: string, email: string): Promise<void> {
  const now = new Date()

  await tx
    .updateTable("user")
    .set({
      deletedAt: now,
      email: `deleted+${userId}@invalid`,
      name: null,
      image: null,
      // The GitHub identity goes too, or signing in again would resurrect the account rather than
      // create a new one.
      githubUserId: null,
      githubLogin: null,
      updatedAt: now,
    })
    .where("id", "=", userId)
    .execute()

  await revokeAndDetach(tx, userId, email, now)
}

async function revokeAndDetach(
  tx: Kysely<DB>,
  userId: string,
  email: string,
  now: Date,
): Promise<void> {
  /*
    Everything that could still authenticate, in the same transaction.

    Sessions and OAuth codes are deleted rather than marked: they are short-lived and reference
    nothing that has to survive. API keys and OAuth tokens are *revoked*, because `audit_log` points
    at them and a trail whose subject vanished cannot be read.
  */
  await tx.deleteFrom("session").where("userId", "=", userId).execute()
  await tx.deleteFrom("account").where("userId", "=", userId).execute()
  await tx.deleteFrom("oauthAuthorizationCode").where("userId", "=", userId).execute()

  await tx
    .updateTable("apiKey")
    .set({ revokedAt: now })
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .execute()

  await tx
    .updateTable("oauthAccessToken")
    .set({ revokedAt: now })
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .execute()

  await tx
    .updateTable("oauthGrant")
    .set({ revokedAt: now })
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .execute()

  /*
    Memberships go entirely.

    A closed account must not still appear in someone else's member list, and `organization_member`
    is `ON DELETE CASCADE` on the user anyway — this only makes it happen now rather than at a hard
    delete that will never come.
  */
  await tx.deleteFrom("organizationMember").where("userId", "=", userId).execute()
  await tx.deleteFrom("memberPermission").where("userId", "=", userId).execute()
  await tx.deleteFrom("userPreference").where("userId", "=", userId).execute()

  /*
    Any pending invitation is now addressed to nobody.

    Matched on the email captured *before* it was overwritten — `organization_invite` has no user
    id, because an invitation can be sent to someone who has not signed up. That also means an
    invite outlives the account it was sent to, and accepting it later would create a fresh user
    with the same address as a closed one.
  */
  await tx
    .updateTable("organizationInvite")
    .set({ revokedAt: now })
    .where("email", "=", email)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .execute()
}
