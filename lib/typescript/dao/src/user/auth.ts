import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export type SessionUser = Pick<Selectable<DB["user"]>, "id" | "isAdmin" | "name" | "email">

/** The session columns an authorization decision actually needs.
 *
 *  The row also carries `reauthenticated_at` for step-up re-auth and
 *  `user_agent` / `ip` for a sign-out-other-sessions screen. Selecting those on
 *  every request would cost a wider read on the hottest path in the product for
 *  data no caller here reads. */
export type AuthSession = Pick<
  Selectable<DB["session"]>,
  "sessionKey" | "userId" | "expires" | "impersonatedByUserId"
>

type SessionValidationResult = {
  session: AuthSession
  user: SessionUser
} | null

export function authUser(db: Kysely<DB>) {
  async function validateSessionToken(sessionKey: string): Promise<SessionValidationResult> {
    const row = await db
      .selectFrom("session")
      .innerJoin("user", "user.id", "session.userId")
      .where("session.sessionKey", "=", sessionKey)
      .select([
        "session.sessionKey",
        "session.expires",
        "session.userId",
        // Read on every request, unlike the other wide columns, because every *write* has to stamp
        // it. A route that could not see it would attribute a support action to the customer.
        "session.impersonatedByUserId",
        "user.id",
        "user.isAdmin",
        "user.name",
        "user.email",
      ])
      .executeTakeFirst()

    if (!row) {
      return null
    }
    const session: AuthSession = {
      sessionKey: row.sessionKey,
      userId: row.userId,
      expires: row.expires,
      impersonatedByUserId: row.impersonatedByUserId,
    }
    const user: SessionUser = {
      id: row.id,
      isAdmin: row.isAdmin,
      name: row.name,
      email: row.email,
    }
    if (Date.now() >= session.expires.getTime()) {
      await db.deleteFrom("session").where("sessionKey", "=", session.sessionKey).execute()
      return null
    }
    /*
      Sliding expiry, but never for an impersonated session.

      This is not a nicety. An impersonated session is issued for one hour, and one hour is well
      inside the fifteen-day renewal window — so without this guard the *first request* an admin
      made while impersonating would extend a stranger's session to thirty days. The short expiry
      would have been decorative, and nothing about the code that set it would have looked wrong.
    */
    if (
      session.impersonatedByUserId === null &&
      Date.now() >= session.expires.getTime() - 1000 * 60 * 60 * 24 * 15
    ) {
      session.expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      await db
        .updateTable("session")
        .set("expires", session.expires)
        .where("sessionKey", "=", session.sessionKey)
        .execute()
    }
    return { session, user }
  }

  return { validateSessionToken }
}
