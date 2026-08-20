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
    scopes: scope === null ? [] : scope.split(" ").filter((s) => s !== ""),
    accessTokenExpiresInSeconds: typeof expiresIn === "number" ? expiresIn : null,
  }
}
