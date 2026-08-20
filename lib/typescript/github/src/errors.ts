/**
 * Every failure this package can produce is one of these.
 *
 * A raw `fetch` rejection is a `TypeError` with a message that varies by runtime, and a 403 from
 * GitHub is indistinguishable from a rate limit unless you read the headers. Callers that have to
 * decide "retry later" versus "this will never work" cannot do that against either, so nothing
 * here ever escapes as the underlying error.
 */
export class GitHubError extends Error {
  override readonly name: string = "GitHubError"
}

/** The request never reached GitHub: DNS, TLS, connection reset, abort. Always retryable. */
export class GitHubTransportError extends GitHubError {
  override readonly name = "GitHubTransportError"

  constructor(path: string, options?: { cause?: unknown }) {
    super(`Could not reach the GitHub API (${path})`, options)
  }
}

/** GitHub answered with a status we did not ask for. */
export class GitHubApiError extends GitHubError {
  override readonly name: string = "GitHubApiError"

  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    readonly documentationUrl: string | null = null,
  ) {
    super(message)
  }
}

/** 401, or a 403 that is about the token rather than about quota. */
export class GitHubAuthError extends GitHubApiError {
  override readonly name = "GitHubAuthError"
}

export class GitHubNotFoundError extends GitHubApiError {
  override readonly name = "GitHubNotFoundError"
}

/** 422 — the request was understood and refused. A repository name already in use lands here. */
export class GitHubValidationError extends GitHubApiError {
  override readonly name = "GitHubValidationError"
}

/**
 * Primary or secondary rate limit.
 *
 * `retryAfterSeconds` is what a caller should actually wait: `retry-after` when GitHub sent one
 * (secondary limits), otherwise the distance to `x-ratelimit-reset`. It is never negative, so a
 * clock skew cannot turn a backoff into a hot loop.
 */
export class GitHubRateLimitError extends GitHubApiError {
  override readonly name = "GitHubRateLimitError"

  constructor(
    status: number,
    path: string,
    message: string,
    readonly retryAfterSeconds: number,
    readonly resetAt: Date | null,
    readonly secondary: boolean,
  ) {
    super(status, path, message)
  }
}

/**
 * A credential was presented for an endpoint that does not accept its kind.
 *
 * The type signatures already stop this at compile time; this exists for the call that crossed a
 * boundary where the types were lost — a value parsed from JSON, a cast. See ADR 0005: GitHub's
 * own OpenAPI description marks `POST /user/repos` `enabledForGitHubApps: false`, so an
 * installation token there fails with a 403 that reads like a permissions problem.
 */
export class GitHubCredentialError extends GitHubError {
  override readonly name = "GitHubCredentialError"
}

/** `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` is missing or empty. */
export class MissingGitHubAppConfigError extends GitHubError {
  override readonly name = "MissingGitHubAppConfigError"

  constructor(variable: string) {
    super(
      `${variable} is not set. GitHub App installation tokens cannot be minted without it; ` +
        `set it from the app's private key, or use a user OAuth token for this operation.`,
    )
  }
}
