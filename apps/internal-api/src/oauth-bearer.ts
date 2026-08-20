import { introspect } from "@lib/oauth-provider"
import { db } from "@sproutos/db"
import { createMiddleware } from "hono/factory"

/**
 * The resource-server half of TASK 6, and the half that is easy to forget.
 *
 * An OAuth token is not a session. Its power is the **intersection** of two things:
 *
 *   what the user can do  ∩  what they granted the client
 *
 * Either alone is wrong. Using only the scopes lets a client hold `org:delete` after the user is
 * demoted to member — a grant made in March quietly outliving the permission it was based on.
 * Using only RBAC makes the scopes decorative, so a read-only integration could delete a project.
 *
 * So this middleware establishes *who* the token acts as and *what it was granted*, and
 * `requirePermission` intersects the two. The RBAC check still runs, unchanged, against the user.
 */

export type BearerContext = {
  userId: string
  organizationId: string
  oauthClientId: string
  scopes: string[]
}

/** A bearer token from `Authorization: Bearer …`, or nothing. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * Accept either a session cookie or a bearer token.
 *
 * Deliberately not a second copy of `authMiddleware`. A route that authenticates one way but
 * authorizes another is how a scope check gets skipped, so both paths land in the same variables
 * and the same `requirePermission`.
 */
export const bearerMiddleware = createMiddleware<{
  Variables: {
    oauth: BearerContext | null
  }
}>(async (c, next) => {
  const token = readBearerToken(c.req.header("authorization"))
  if (token === null) {
    c.set("oauth", null)
    await next()
    return undefined
  }

  const introspected = await introspect(db, token)
  if (
    !introspected.active ||
    introspected.userId === undefined ||
    introspected.organizationId === undefined ||
    introspected.oauthClientId === undefined
  ) {
    // RFC 6750 §3.1: an invalid token is 401 with WWW-Authenticate, not 403. A client has to be
    // able to tell "refresh and retry" from "you will never be allowed to do this".
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
    return c.json({ error: "invalid_token", error_description: "The token is not valid" }, 401)
  }

  c.set("oauth", {
    userId: introspected.userId,
    organizationId: introspected.organizationId,
    oauthClientId: introspected.oauthClientId,
    scopes: introspected.scopes ?? [],
  })

  await next()
  return undefined
})

/**
 * Whether a granted scope set covers an action.
 *
 * Scopes are RBAC actions, so this is a set membership test plus the same wildcard shape the RBAC
 * catalogue uses: `project:*` covers `project:read`, and `*` covers everything. There is no second
 * vocabulary to keep in step.
 */
export function scopesCover(scopes: readonly string[], action: string): boolean {
  if (scopes.includes("*") || scopes.includes(action)) return true

  const parts = action.split(":")
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    if (scopes.includes(`${parts.slice(0, depth).join(":")}:*`)) return true
  }
  return false
}
