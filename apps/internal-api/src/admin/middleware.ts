import type { AuthSession, SessionUser } from "@lib/dao/user/auth"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { getSession } from "../middleware"

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
  c.set("user", session.user)
  c.set("session", session.session)

  await next()
})
