import { encodeBase64, encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"
import { OAuth2RequestError, OAuth2ResponseError } from "./errors"
import { type OAuth2Tokens, parseTokenResponse } from "./tokens"

export interface OAuth2Endpoints {
  readonly authorization: string
  readonly token: string
}

export interface OAuth2ClientConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly endpoints: OAuth2Endpoints
}

/** The PKCE `code_challenge` for a verifier: base64url(SHA-256(verifier)), per RFC 7636 §4.2.
 *
 *  Only S256 is implemented. The spec's `plain` method offers no protection against an attacker
 *  who can read the authorization request, so there is no reason to support it. */
export async function createS256CodeChallenge(codeVerifier: string): Promise<string> {
  return encodeBase64UrlNoPadding(await sha256Utf8(codeVerifier))
}

/** A minimal OAuth 2.0 authorization-code client with PKCE.
 *
 *  Scoped to what this repo actually does: send the user to the provider, trade the returned code
 *  for tokens, and refresh an access token later. Token revocation, implicit flow, device flow and
 *  client-credentials are all deliberately absent — add them when something needs them. */
export class OAuth2Client {
  constructor(private readonly config: OAuth2ClientConfig) {}

  /** Build the URL to send the user to. `state` and `codeVerifier` must be stored server-side
   *  (we use short-lived httpOnly cookies) and checked when the provider redirects back. */
  async createAuthorizationUrl(
    state: string,
    codeVerifier: string,
    scopes: readonly string[],
  ): Promise<URL> {
    const url = new URL(this.config.endpoints.authorization)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", this.config.clientId)
    url.searchParams.set("redirect_uri", this.config.redirectUri)
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("code_challenge", await createS256CodeChallenge(codeVerifier))
    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "))
    }
    return url
  }

  /** Exchange an authorization code for tokens. The `codeVerifier` must be the one whose
   *  challenge was sent in the authorization request. */
  async validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuth2Tokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    })
    return await this.sendTokenRequest(body)
  }

  /** Trade a refresh token for a fresh access token. */
  async refreshAccessToken(refreshToken: string): Promise<OAuth2Tokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
    return await this.sendTokenRequest(body)
  }

  private async sendTokenRequest(body: URLSearchParams): Promise<OAuth2Tokens> {
    // HTTP Basic is the client authentication method RFC 6749 §2.3.1 requires servers to support,
    // and it keeps the secret out of the request body.
    const credentials = encodeBase64(
      new TextEncoder().encode(`${this.config.clientId}:${this.config.clientSecret}`),
    )

    let response: Response
    try {
      response = await fetch(this.config.endpoints.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${credentials}`,
        },
        body: body.toString(),
      })
    } catch (cause) {
      throw new OAuth2ResponseError("Could not reach the token endpoint", null, { cause })
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (cause) {
      throw new OAuth2ResponseError("Token endpoint did not return JSON", response.status, {
        cause,
      })
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new OAuth2ResponseError("Token endpoint returned a non-object body", response.status)
    }
    const payload = data as Record<string, unknown>

    if (!response.ok) {
      const code = payload.error
      if (typeof code !== "string") {
        throw new OAuth2ResponseError(
          "Token endpoint returned an error without a code",
          response.status,
        )
      }
      const description = payload.error_description
      throw new OAuth2RequestError(code, typeof description === "string" ? description : null)
    }

    return parseTokenResponse(payload)
  }
}
