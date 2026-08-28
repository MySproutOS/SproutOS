import { KEY_PREFIX, resolveKey, stampUsed } from "@lib/api-keys"
import { introspect } from "@lib/oauth-provider"
import type { DB } from "@sproutos/db"
import { db } from "@sproutos/db"
import type { Context } from "hono"
import type { Selectable } from "kysely"
import type { AuthContext } from "./middleware"
import { ErrorCode } from "./utils/errors.enum"
import { throwHTTPException } from "./utils/http-exception"

type SessionUser = Pick<Selectable<DB["user"]>, "id" | "isAdmin" | "name" | "email">

/**
 * The resource-server half of TASK 6, and the half that is easy to forget.
 *
 * A bearer credential is not a session. Its power is the **intersection** of two things:
 *
 *   what the user can do  ∩  what the credential was granted
 *
 * Either alone is wrong. Scopes alone let a token keep `org:delete` after the user is demoted to
 * member — a grant made in March quietly outliving the permission it was based on. RBAC alone makes
 * the scopes decorative, so a read-only integration could delete a project.
 *
 * This establishes *who* the credential acts as and *what it was granted*; `requirePermission`
 * intersects the two.
 */

/** A bearer token from `Authorization: Bearer …`, or nothing. */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

export type BearerResult = { user: SessionUser; auth: AuthContext }

async function loadUser(userId: string): Promise<SessionUser | undefined> {
  return await db
    .selectFrom("user")
    .select(["id", "isAdmin", "name", "email"])
    .where("id", "=", userId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
}

/** RFC 6750 §3.1: an invalid token is 401 with `WWW-Authenticate`, never 403. */
function invalidToken(c: Context): never {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
  // A client has to be able to tell "refresh and retry" from "you will never be allowed to do this".
  return throwHTTPException(401, ErrorCode.Unauthenticated, "The token is not valid")
}

/**
 * Authenticates a bearer credential, or returns null when there is none.
 *
 * Null means "no bearer token was sent" — the caller falls through to the session cookie. A token
 * that was sent and is *bad* throws, because falling through would turn a revoked key into an
 * anonymous request and produce a 401 that says the wrong thing.
 */
export async function authenticateBearer(c: Context): Promise<BearerResult | null> {
  const header = c.req.header("authorization")
  if (header === undefined) return null
  const token = readBearerToken(header)
  if (token === null) invalidToken(c)

  /*
    An API key and an OAuth token travel in the same header and are told apart by the key's prefix.

    One header because that is what every HTTP client already sends, and because two would mean two
    code paths to keep in step.
  */
  if (token.startsWith(KEY_PREFIX)) {
    const resolved = await resolveKey(db, token)
    // One answer for unknown, revoked and expired — see `resolveKey`.
    if (resolved === undefined) invalidToken(c)

    const user = await loadUser(resolved.userId)
    // A key whose owner is gone authenticates as nobody, so it authenticates as nothing.
    if (user === undefined) invalidToken(c)

    // Not awaited: a bookkeeping write must not be able to fail a request.
    void stampUsed(db, resolved.id)

    return {
      user,
      auth: {
        kind: "api_key",
        scopes: resolved.scopes,
        organizationId: resolved.organizationId,
        apiKeyId: resolved.id,
        oauthGrantId: resolved.oauthGrantId,
      },
    }
  }

  const introspected = await introspect(db, token)
  if (
    !introspected.active ||
    introspected.userId === undefined ||
    introspected.oauthClientId === undefined ||
    introspected.organizationId === undefined ||
    // Refused rather than defaulted. A token with no grant cannot have anything it creates
    // attributed to one, so it could mint a credential that revoking consent would never find.
    introspected.oauthGrantId === undefined
  ) {
    invalidToken(c)
  }

  const user = await loadUser(introspected.userId)
  if (user === undefined) invalidToken(c)

  return {
    user,
    auth: {
      kind: "oauth",
      scopes: introspected.scopes ?? [],
      organizationId: introspected.organizationId,
      oauthClientId: introspected.oauthClientId,
      oauthGrantId: introspected.oauthGrantId,
    },
  }
}
