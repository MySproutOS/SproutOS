import type { AuthSession, SessionUser } from "@lib/dao/user/auth"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { getSession } from "../middleware"

/**
 * The platform surface, and who reaches it.
 *
 * `user.is_admin` is the whole of the check. There is deliberately no role system here: platform
 * administration is not a tenant's RBAC problem, the population is a handful of people, and a
 * second permission model to keep in step with the first is how one of them drifts.
 *
 * What `is_admin` grants is defined in `docs/adr/0019-platform-admin.md` and is narrow on purpose:
 * read across organizations, and the ability to *become* a user through an audited impersonation.
 * It grants no write into a customer's data directly — every such change is made as the customer,
 * through a session that records who was really behind it.
 */
export const adminAuthMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser
    session: AuthSession
  }
}>(async (c, next) => {
  const session = await getSession(c)

  if (!session.user.isAdmin) {
    throw new HTTPException(403)
  }

  /*
    An impersonated session never reaches here, even if the person being impersonated is an admin.

    Two reasons, and the second is the one that matters. It stops impersonation chaining — admin
    becomes user, and from inside that session becomes a third — which would turn an audit trail
    that reads as a pair into one that has to be reconstructed as a chain. And it means the platform
    surface is only ever reached by someone signed in as themselves, which is what makes
    `audit_log.actor_user_id` on an admin action mean what it says.

    `start()` already refuses to impersonate an admin, so this is the second of two locks on the
    same door. It is here anyway: the day someone relaxes that rule for a good reason, this is what
    stops the good reason from also being a privilege escalation.
  */
  if (session.session.impersonatedByUserId !== null) {
    throw new HTTPException(403, {
      message: "The platform surface cannot be reached from an impersonated session",
    })
  }

  c.set("user", session.user)
  c.set("session", session.session)

  await next()
})
