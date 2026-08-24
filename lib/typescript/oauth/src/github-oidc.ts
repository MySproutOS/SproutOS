import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"

/**
 * Verifying a GitHub Actions OIDC token.
 *
 * A customer's workflow presents one of these to prove it is running in a particular repository,
 * and SproutOS exchanges it for a deploy token. **The signature check below is the entire security
 * of that exchange.** Without it, anyone who can construct a JSON object could deploy to anyone's
 * project — the claims are attacker-controlled until the signature says otherwise.
 *
 * `decodeJwtPayload` in this package deliberately does not verify, because it is used on tokens
 * read straight out of a token response over TLS from the issuer. That reasoning does not apply
 * here: this token arrives from the client.
 */

/** GitHub's issuer for Actions OIDC. Anything else is not GitHub, whatever it claims. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"

const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`

/**
 * The audience SproutOS mints tokens for.
 *
 * Not optional and not a default. GitHub will issue a token for whatever audience a workflow asks
 * for, so a token minted for some other service would otherwise verify here — the audience is the
 * claim that says "this was made for us".
 */
export const SPROUTOS_AUDIENCE = "sproutos"

export class OidcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OidcError"
  }
}

export type GitHubOidcClaims = {
  /** `owner/repo`. */
  repository: string
  repositoryOwner: string
  /** `repo:owner/name:ref:refs/heads/main` — the whole subject, for audit. */
  sub: string
  ref: string
  sha: string
  workflow: string
  runId: string
  actor: string
}

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string }

/**
 * Cached JWKS.
 *
 * GitHub rotates these, so a permanent cache eventually rejects every valid token — and no cache
 * means a network call on every deploy. The refresh below is keyed on a *miss*: an unknown `kid` is
 * the signal that rotation happened, which is more responsive than any TTL and cheaper than none.
 */
let cachedKeys: Map<string, Jwk> | undefined
let cachedAt = 0
const MAX_CACHE_MS = 10 * 60 * 1000

async function fetchKeys(): Promise<Map<string, Jwk>> {
  const response = await fetch(JWKS_URL)
  if (!response.ok) throw new OidcError(`could not fetch GitHub's JWKS: ${response.status}`)

  const body = (await response.json()) as { keys: Jwk[] }
  const keys = new Map(body.keys.map((key) => [key.kid, key]))
  cachedKeys = keys
  cachedAt = Date.now()
  return keys
}

async function keyFor(kid: string): Promise<Jwk> {
  if (cachedKeys !== undefined && Date.now() - cachedAt < MAX_CACHE_MS) {
    const cached = cachedKeys.get(kid)
    if (cached !== undefined) return cached
  }

  // A `kid` we have not seen means either rotation or a forged header. Refetching answers both:
  // after a refresh, a key that still does not exist is not GitHub's.
  const keys = await fetchKeys()
  const key = keys.get(kid)
  if (key === undefined) throw new OidcError(`no GitHub signing key for kid ${kid}`)
  return key
}

/** Reset the cache. For tests, and for an operator who has reason to believe it is poisoned. */
export function resetOidcKeyCache(): void {
  cachedKeys = undefined
  cachedAt = 0
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

/**
 * Verify a GitHub Actions OIDC token and return its claims.
 *
 * Every check here has a specific forgery it prevents, and none is decoration:
 *
 * - **`alg` must be RS256.** `none` is the classic JWT forgery, and accepting whatever the header
 *   asks for is how it works. The algorithm is decided by us, not by the token.
 * - **The signature must verify** against a key GitHub publishes.
 * - **`iss` must be GitHub's.** A token from another issuer, signed correctly by that issuer, is a
 *   valid token for something else.
 * - **`aud` must be ours.** GitHub issues tokens for any audience a workflow asks for; without this
 *   a token minted for a different service deploys here.
 * - **`exp` and `nbf`** with no leeway. These live for minutes by design.
 */
export async function verifyGitHubOidcToken(
  token: string,
  now: () => number = Date.now,
): Promise<GitHubOidcClaims> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new OidcError("not a JWT")

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]

  const header = JSON.parse(base64UrlToBuffer(encodedHeader).toString("utf8")) as {
    alg?: string
    kid?: string
  }

  // Decided here, not read from the token. `alg: "none"` is the oldest JWT forgery there is.
  if (header.alg !== "RS256") throw new OidcError(`unsupported alg ${String(header.alg)}`)
  if (typeof header.kid !== "string") throw new OidcError("no kid in the token header")

  const jwk = await keyFor(header.kid)
  const publicKey = createPublicKey({ key: jwk, format: "jwk" })

  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8")
  if (!verifySignature("RSA-SHA256", signed, publicKey, base64UrlToBuffer(encodedSignature))) {
    throw new OidcError("signature does not verify")
  }

  const claims = JSON.parse(base64UrlToBuffer(encodedPayload).toString("utf8")) as Record<
    string,
    unknown
  >

  if (claims.iss !== GITHUB_OIDC_ISSUER) {
    throw new OidcError(`unexpected issuer ${String(claims.iss)}`)
  }

  // `aud` may be a string or an array; both forms are legal and both must be handled or a valid
  // token is rejected for the wrong reason.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(SPROUTOS_AUDIENCE)) {
    throw new OidcError("token was not minted for SproutOS")
  }

  const seconds = Math.floor(now() / 1000)
  if (typeof claims.exp !== "number" || claims.exp <= seconds) throw new OidcError("token expired")
  if (typeof claims.nbf === "number" && claims.nbf > seconds) {
    throw new OidcError("token is not valid yet")
  }

  const repository = claims.repository
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new OidcError("token carries no repository")
  }

  return {
    repository,
    repositoryOwner: text(claims.repository_owner) || (repository.split("/")[0] ?? ""),
    sub: text(claims.sub),
    ref: text(claims.ref),
    sha: text(claims.sha),
    workflow: text(claims.workflow),
    runId: text(claims.run_id),
    actor: text(claims.actor),
  }
}

/**
 * A claim as a string, or empty if it is anything else.
 *
 * Not `String(value)`: these claims are attacker-supplied JSON until the signature has been checked,
 * and after it has been checked they are still whatever GitHub put there. `String({})` is
 * `"[object Object]"`, which would then be written into an audit row as if it were an actor name.
 * Only `run_id` is documented as a number, and it is wanted as text, so that is the one conversion
 * worth making explicitly.
 */
function text(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return ""
}

/** A stable fingerprint of a token, for audit without storing the token. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16)
}
