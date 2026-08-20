import type { DB } from "@sproutos/db"
import type { SessionUser } from "@lib/dao/user/auth"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { Selectable } from "kysely"
import { getSession } from "../middleware"

export const adminAuthMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser
    session: Selectable<DB["session"]>
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
