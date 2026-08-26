import { createSign } from "node:crypto"
import type { GitHubClient } from "./client"
import { MissingGitHubAppConfigError } from "./errors"
import { appJwt, type GitHubInstallationToken, installationToken } from "./types"

export type GitHubAppConfig = {
  readonly appId: string
  readonly privateKeyPem: string
}

/** GitHub rejects a JWT whose `exp` is more than ten minutes out. Nine leaves room for skew. */
const JWT_LIFETIME_SECONDS = 540
/** `iat` is backdated because GitHub's clock is not ours and a future `iat` is rejected outright. */
const JWT_BACKDATE_SECONDS = 60

/** Refresh an installation token this long before it actually expires. */
const DEFAULT_SKEW_SECONDS = 300

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

/**
 * Reads the app credentials from the environment, failing with a sentence a reader can act on.
 *
 * `GITHUB_APP_PRIVATE_KEY` is empty in development, and a crash inside a signing routine ten
 * frames down would be reported as "error:1E08010C:DECODER routines::unsupported". Callers that
 * can fall back to a user OAuth token catch [[MissingGitHubAppConfigError]] and do so.
 *
 * The `\n`-escaped form is accepted because a PEM does not survive a single-line `.env` otherwise.
 */
export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const appId = env.GITHUB_APP_ID
  if (appId === undefined || appId === "") throw new MissingGitHubAppConfigError("GITHUB_APP_ID")

  const key = env.GITHUB_APP_PRIVATE_KEY
  if (key === undefined || key === "") {
    throw new MissingGitHubAppConfigError("GITHUB_APP_PRIVATE_KEY")
  }

  return { appId, privateKeyPem: key.includes("\\n") ? key.replaceAll("\\n", "\n") : key }
}

/**
 * The app's own RS256 assertion, good only for `/app/*`.
 *
 * Hand-rolled rather than pulled from a JWT library for the same reason `@lib/oauth` is vendored:
 * this is thirty lines of `node:crypto` and one algorithm, and the dependency would be a supply
 * chain in the path of every repository the platform creates.
 */
export function createAppJwt(config: GitHubAppConfig, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_SECONDS

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64Url(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
      iss: config.appId,
    }),
  )

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(config.privateKeyPem)

  return `${header}.${payload}.${base64Url(signature)}`
}

export type InstallationTokenStoreOptions = {
  client: GitHubClient
  /**
   * Produces the app JWT. A function rather than a `GitHubAppConfig` so the store can be built
   * before the key is needed — and so tests can drive the whole exchange without one.
   */
  signJwt: () => string
  now?: () => Date
  skewSeconds?: number
}

type InstallationTokenResponse = {
  token: string
  expires_at: string
}

/**
 * Mints and caches `ghs_` installation tokens.
 *
 * Tokens last an hour and every mint costs a JWT signature plus a round trip, so upkeep across a
 * few hundred repositories on one installation would otherwise spend a meaningful fraction of its
 * budget re-authenticating. Cached until five minutes before expiry: a token that dies halfway
 * through a fork is a half-created repository, which is far more expensive than an early refresh.
 *
 * In-process only, deliberately. An installation token in a shared cache is a credential at rest
 * with no envelope around it, and re-minting after a deploy costs one request.
 */
export function createInstallationTokenStore(options: InstallationTokenStoreOptions) {
  const now = options.now ?? (() => new Date())
  const skewMs = (options.skewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
  const cache = new Map<number, GitHubInstallationToken>()

  function cached(installationId: number): GitHubInstallationToken | undefined {
    const entry = cache.get(installationId)
    if (entry === undefined) return undefined

    if (entry.expiresAt.getTime() - skewMs <= now().getTime()) {
      cache.delete(installationId)
      return undefined
    }

    return entry
  }

  async function get(installationId: number): Promise<GitHubInstallationToken> {
    const hit = cached(installationId)
    if (hit !== undefined) return hit

    const response = await options.client.request<InstallationTokenResponse>({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      credential: appJwt(options.signJwt()),
    })

    const minted = installationToken(
      response.data.token,
      installationId,
      new Date(response.data.expires_at),
    )

    cache.set(installationId, minted)
    return minted
  }

  function clear(installationId?: number): void {
    if (installationId === undefined) cache.clear()
    else cache.delete(installationId)
  }

  return { clear, get }
}

/** The production signer: reads the environment on every call, so a rotated key is picked up. */
export function envAppJwtSigner(env: NodeJS.ProcessEnv = process.env): () => string {
  return () => createAppJwt(githubAppConfigFromEnv(env))
}

/**
 * The App's own slug, which is the only way to build its installation URL.
 *
 * `https://github.com/apps/<slug>/installations/new` is where a customer installs the App on an
 * account that does not have it, and the slug is not `GITHUB_APP_ID` — that is a number, and the
 * URL wants the name GitHub derived from the App's title. Nothing in this repository knew it, so
 * nothing could offer the link, so an organization with the App on one account had no way to reach
 * any other and no way to be told that installing it elsewhere was even possible.
 *
 * Cached for the process: it changes only if somebody renames the App, and it costs a signature
 * plus a round trip.
 */
export async function githubAppSlug(client: GitHubClient, signJwt: () => string): Promise<string> {
  if (cachedSlug !== null) return cachedSlug

  const response = await client.request<{ slug?: string }>({
    method: "GET",
    path: "/app",
    credential: appJwt(signJwt()),
  })

  const slug = response.data.slug
  if (slug === undefined || slug === "") {
    throw new Error("GitHub did not return a slug for this App")
  }

  cachedSlug = slug
  return slug
}

let cachedSlug: string | null = null
