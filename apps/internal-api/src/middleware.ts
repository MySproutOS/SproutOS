import { type AuthSession, authUser } from "@lib/dao"
import type { DB } from "@sproutos/db"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import type { Context, Env } from "hono"
import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { Selectable } from "kysely"
import { authenticateBearer } from "./bearer"
import { ErrorCode } from "./utils/errors.enum"
import { throwHTTPException } from "./utils/http-exception"

type SessionUser = Pick<Selectable<DB["user"]>, "id" | "isAdmin" | "name" | "email">

export async function getSession<E extends Env>(
  /*
    Typed on what it actually reads.

    It takes the session cookie off the request and returns a session; it never touches the
    variables. Naming the exact `Variables` shape in the parameter type made every caller's context
    have to match it, which is why widening `session` to nullable broke a function that does not
    read `session` at all.
  */
  c: Context<E>,
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

/**
 * How the caller proved who they are, and what they were granted.
 *
 * A session is a person at a browser and carries no scopes — their RBAC is the whole answer. A
 * bearer credential carries scopes, and its power is the **intersection** of those with the user's
 * live RBAC. `requirePermission` reads this; see `rbac/require-permission.ts`.
 */
export type AuthContext =
  | { kind: "session"; scopes: null }
  | { kind: "oauth"; scopes: string[]; oauthClientId: string }
  | { kind: "api_key"; scopes: string[]; apiKeyId: string }

export const authMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser
    /** Null when the caller authenticated with a bearer credential rather than a cookie. */
    session: AuthSession | null
    auth: AuthContext
  }
}>(async (c, next) => {
  /*
    A bearer credential first, and only then the cookie.

    Both are checked in one middleware rather than two, because a route that authenticates one way
    but authorizes another is exactly how a scope check gets skipped — every caller lands in the
    same `user` and the same `requirePermission`.
  */
  const bearer = await authenticateBearer(c)
  if (bearer !== null) {
    c.set("user", bearer.user)
    c.set("session", null)
    c.set("auth", bearer.auth)
    await next()
    return undefined
  }

  const session = await getSession(c)
  c.set("user", session.user)
  c.set("session", session.session)
  c.set("auth", { kind: "session", scopes: null })

  await next()
  return undefined
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
