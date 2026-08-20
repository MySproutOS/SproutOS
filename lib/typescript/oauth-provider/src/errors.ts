/**
 * RFC 6749 §5.2 error codes, as an authorization server must return them.
 *
 * The code is part of the protocol — a client branches on `invalid_grant` to know its refresh
 * token is dead — so these are not free-form strings and the description never carries detail an
 * attacker could use to distinguish "no such client" from "wrong secret".
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"

export class OAuthError extends Error {
  override readonly name = "OAuthError"

  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    /** 401 for client authentication failures, 400 for everything else. */
    readonly status: 400 | 401 = 400,
  ) {
    super(`${code}: ${description}`)
  }

  toJSON(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description }
  }
}
