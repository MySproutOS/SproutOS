/** The provider replied with a well-formed OAuth 2.0 error (RFC 6749 §5.2).
 *
 *  `code` is the machine-readable value, e.g. `invalid_grant` for a reused or expired
 *  authorization code. */
export class OAuth2RequestError extends Error {
  readonly code: string
  readonly description: string | null

  constructor(code: string, description: string | null) {
    super(`OAuth 2.0 request failed: ${code}${description === null ? "" : ` (${description})`}`)
    this.name = "OAuth2RequestError"
    this.code = code
    this.description = description
  }
}

/** The request never completed, or the provider replied with something we cannot interpret. */
export class OAuth2ResponseError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "OAuth2ResponseError"
    this.status = status
  }
}
