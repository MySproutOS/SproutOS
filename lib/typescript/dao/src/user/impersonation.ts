import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * A platform admin looking at the product as one customer sees it.
 *
 * This exists because the alternative is worse. A support question about a screen nobody else can
 * reach, or a bug that only reproduces under one organization's data, gets answered either by
 * impersonation or by someone opening `psql` against production — which is unaudited, ad hoc, and
 * one typo from a write. Making it a supported, recorded operation is what keeps it out of the
 * shell.
 *
 * Four properties, each of which is the reason for a specific line below.
 *
 * **It is a separate session, minted for the target user.** Not a flag on the admin's own session
 * with the target passed per request — that would put the burden on every route to remember, and
 * the route that forgets is the one that writes an unattributed row. Here the impersonated identity
 * is the ordinary one: existing routes authenticate it exactly as they authenticate anybody.
 *
 * **It expires in an hour, not thirty days.** A support investigation is minutes; a session that
 * outlives it is a credential for somebody else's account sitting in a browser.
 *
 * **It cannot reach the admin surface.** Otherwise an admin impersonates a user, and from inside
 * that session impersonates a third — an audit trail that has to be read as a chain rather than a
 * pair, and a privilege the impersonated user never had.
 *
 * **Everything done in it names both people.** `audit_log.impersonator_user_id` is what makes the
 * customer's own trail true: without it their id appears against actions they did not take.
 */

/** How long an impersonated session lasts. Support work is minutes; this is generous. */
export const IMPERSONATION_MINUTES = 60

export type StartImpersonation =
  | { ok: true; expires: Date }
  | {
      ok: false
      reason: "not_admin" | "target_not_found" | "target_is_admin" | "already_impersonating"
    }

export type ImpersonationContext = {
  /** The admin behind the session, or `null` for an ordinary one. */
  impersonatedByUserId: string | null
}

export function impersonation(db: Kysely<DB>) {
  /**
   * Mint a session for `targetUserId`, attributed to `adminUserId`.
   *
   * Refuses to impersonate another admin. Not paranoia about admins: an admin's session is the one
   * that can reach the platform surface, and impersonating one would be a way to borrow that reach
   * while the audit trail said somebody else's name. Support never needs it — an admin with a
   * problem can be asked.
   */
  async function start(
    adminUserId: string,
    targetUserId: string,
    /**
     * The **hashed** token, not the token.
     *
     * Same division as the rest of session handling: the app layer mints a token and hashes it, and
     * this layer never sees the plaintext. It is not ceremony — it is what keeps the one value that
     * would authenticate as somebody else out of every stack trace and query log below this line.
     */
    sessionKey: string,
  ): Promise<StartImpersonation> {
    const admin = await db
      .selectFrom("user")
      .select("isAdmin")
      .where("id", "=", adminUserId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    // Re-read rather than trusting the caller's session copy. `is_admin` can be revoked between a
    // session being issued and this being called, and this is the call where that matters most.
    if (admin?.isAdmin !== true) return { ok: false, reason: "not_admin" }

    const target = await db
      .selectFrom("user")
      .select(["id", "isAdmin"])
      .where("id", "=", targetUserId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (target === undefined) return { ok: false, reason: "target_not_found" }
    if (target.isAdmin) return { ok: false, reason: "target_is_admin" }

    const expires = new Date(Date.now() + IMPERSONATION_MINUTES * 60 * 1000)

    await db
      .insertInto("session")
      .values({
        sessionKey,
        userId: targetUserId,
        expires,
        impersonatedByUserId: adminUserId,
      })
      .execute()

    return { ok: true, expires }
  }

  /**
   * End one impersonated session.
   *
   * Deleted rather than expired: the row's only purpose was to authenticate, and a support session
   * that has been ended should not be reachable if the cookie is replayed a second later. The
   * `audit_log` rows it produced are what survive, which is the record that matters.
   */
  async function end(sessionKey: string): Promise<boolean> {
    const result = await db
      .deleteFrom("session")
      .where("sessionKey", "=", sessionKey)
      .where("impersonatedByUserId", "is not", null)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  return { end, start }
}
