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
  } catch (cause) {
    /*
      Log the cause. The 503 body deliberately says nothing — an unauthenticated caller learns
      whether a session exists from a 401 and nothing else from this — but discarding the error
      entirely is how a real failure becomes invisible.

      It already did. The control-plane database was rebuilt empty when its pod moved, and the only
      symptom anywhere in the system was this status code with the word "unavailable" and no
      further detail; `/health` was `ok`, and an unauthenticated store query returned an honest
      empty list. Finding out that the `session` table no longer existed took a psql prompt.
    */
    console.error(
      JSON.stringify({
        level: "error",
        message: "session lookup failed",
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
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
  /*
    `oauthGrantId` alongside the client id, because they answer different questions.

    The client is *which application*; the grant is *this user's authorization of it*, which is the
    thing that gets revoked. A credential minted under a token is attributed to the grant so that
    withdrawing consent can find it — see the `oauth_grant_scoped_credentials` migration.
  */
  | {
      kind: "oauth"
      scopes: string[]
      organizationId: string
      oauthClientId: string
      oauthGrantId: string
    }
  | {
      kind: "api_key"
      scopes: string[]
      organizationId: string
      apiKeyId: string
      oauthGrantId: string | null
    }

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

export const optionalAuthMiddleware = createMiddleware<{
  Variables: {
    user: SessionUser | null
    session: AuthSession | null
    auth: AuthContext | null
  }
}>(async (c, next) => {
  const authorization = c.req.header("authorization")
  if (authorization !== undefined) {
    const bearer = await authenticateBearer(c)
    if (bearer === null) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
      return throwHTTPException(401, ErrorCode.Unauthenticated, "The token is not valid")
    }

    c.set("user", bearer.user)
    c.set("session", null)
    c.set("auth", bearer.auth)
    await next()
    return undefined
  }

  try {
    const authenticated = await getSession(c)
    c.set("user", authenticated.user)
    c.set("session", authenticated.session)
    c.set("auth", { kind: "session", scopes: null })
  } catch (error) {
    if (!(error instanceof HTTPException) || error.status !== 401) throw error
    c.set("user", null)
    c.set("session", null)
    c.set("auth", null)
  }

  await next()
  return undefined
})
