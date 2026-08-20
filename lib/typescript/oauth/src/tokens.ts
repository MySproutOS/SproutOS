import { OAuth2ResponseError } from "./errors"

/** A successful token response, parsed and validated once.
 *
 *  arctic modelled this as a class of getters that each threw if their field was missing, so a
 *  malformed response only surfaced at the point of use — often several statements after the
 *  request. Validating up front means a bad response fails at the boundary, and callers get a
 *  plain object whose optional fields are visible in the type. */
export interface OAuth2Tokens {
  readonly accessToken: string
  readonly tokenType: string
  /** Present for OpenID Connect flows, i.e. when `openid` is among the requested scopes. */
  readonly idToken: string | null
  /** Only issued when the provider is asked for offline access. */
  readonly refreshToken: string | null
  /** Empty when the provider echoes no `scope`, which means "exactly what you asked for". */
  readonly scopes: readonly string[]
  readonly accessTokenExpiresInSeconds: number | null
}

function optionalString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  return typeof value === "string" ? value : null
}

/** Split a `scope` value into individual scopes.
 *
 *  RFC 6749 §3.3 delimits scopes with spaces, but GitHub delimits with commas — a space-only
 *  split turns "repo,read:user" into a single bogus scope, and step-up re-authentication then
 *  believes it was granted nothing it recognises. Splitting on either is correct for every
 *  provider we use. A scope token may technically contain a comma under §3.3's grammar; none in
 *  the wild does, and breaking GitHub to preserve that is the wrong trade. */
function parseScopes(scope: string | null): string[] {
  if (scope === null) return []
  return scope.split(/[\s,]+/).filter((s) => s !== "")
}

/** Parse a token endpoint's 200 response body. */
export function parseTokenResponse(data: Record<string, unknown>): OAuth2Tokens {
  const accessToken = optionalString(data, "access_token")
  if (accessToken === null) {
    throw new OAuth2ResponseError("Token response is missing 'access_token'")
  }

  const expiresIn = data.expires_in
  const scope = optionalString(data, "scope")

  return {
    accessToken,
    // RFC 6749 requires token_type, but treat it as advisory: every provider we use issues
    // bearer tokens, and refusing the whole login over a missing hint helps nobody.
    tokenType: optionalString(data, "token_type") ?? "bearer",
    idToken: optionalString(data, "id_token"),
    refreshToken: optionalString(data, "refresh_token"),
    scopes: parseScopes(scope),
    accessTokenExpiresInSeconds: typeof expiresIn === "number" ? expiresIn : null,
  }
}
