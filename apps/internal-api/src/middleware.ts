import { type AuthSession, authUser } from "@lib/dao"
import type { DB } from "@sproutos/db"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import type { Context } from "hono"
import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { Selectable } from "kysely"
import { ErrorCode } from "./utils/errors.enum"
import { throwHTTPException } from "./utils/http-exception"

type SessionUser = Pick<Selectable<DB["user"]>, "id" | "isAdmin" | "name" | "email">

export async function getSession(
  c:
    | Context<{ Variables: { user: SessionUser; session: AuthSession } }, string>
    | Context<{ Variables: { user: SessionUser | null; session: AuthSession | null } }, string>,
) {
  const sessionToken = getCookie(c, "session")
  if (!sessionToken) {
    throwHTTPException(401, ErrorCode.Unauthenticated, "Unauthenticated")
  }

  // The session table stores the hash of the token, not the token itself.
  const sessionId = encodeHexLowerCase(await sha256Utf8(sessionToken))
  let session: Awaited<ReturnType<ReturnType<typeof authUser>["validateSessionToken"]>>
  try {
    session = await authUser(db).validateSessionToken(sessionId)
  } catch {
    // Typically this means we're unable to connect to the database
    return throwHTTPException(503, ErrorCode.ServiceUnavailable, "Service unavailable")
  }

  // Deliberately outside the try: an unknown or expired token is a 401, and wrapping this in the
  // catch above would report it as a 503 — which authNoThrowMiddleware would then not swallow.
  if (!session) throwHTTPException(401, ErrorCode.Unauthenticated, "Unauthenticated")
  return session
}

export const authMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser
    session: AuthSession
  }
}>(async (c, next) => {
  const session = await getSession(c)
  c.set("user", session.user)
  c.set("session", session.session)

  await next()
})

export const authNoThrowMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser | null
    session: AuthSession | null
  }
}>(async (c, next) => {
  try {
    const session = await getSession(c)
    c.set("user", session.user)
    c.set("session", session.session)
  } catch (e) {
    if (e instanceof HTTPException && e.status === 401) {
      c.set("user", null)
      c.set("session", null)
    } else {
      throw e
    }
  }

  await next()
})
