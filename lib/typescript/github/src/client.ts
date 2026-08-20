import {
  GitHubApiError,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubTransportError,
  GitHubValidationError,
} from "./errors"
import type { GitHubCredential, RateLimit } from "./types"

const GITHUB_API = "https://api.github.com"
const API_VERSION = "2022-11-28"

export type GitHubMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

export type GitHubRequest = {
  method: GitHubMethod
  path: string
  credential: GitHubCredential
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** Overrides `Accept`. `POST /repos/{o}/{r}/generate` used to need a preview media type. */
  accept?: string
}

export type GitHubResponse<T> = {
  status: number
  data: T
  rateLimit: RateLimit
}

/**
 * The seam every repository operation is written against.
 *
 * Nothing in this package calls `fetch` except [[createGitHubClient]], so the provisioning tests
 * run against a fake with no network, no credentials, and no rate limit to burn. That is not a
 * testing convenience: exercising fork creation for real would leave repositories behind on
 * somebody's account.
 */
export interface GitHubClient {
  request<T>(request: GitHubRequest): Promise<GitHubResponse<T>>
}

export type GitHubClientOptions = {
  baseUrl?: string
  userAgent?: string
  fetch?: typeof globalThis.fetch
}

function parseInteger(value: string | null): number | null {
  if (value === null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function readRateLimit(headers: Headers): RateLimit {
  const reset = parseInteger(headers.get("x-ratelimit-reset"))

  return {
    limit: parseInteger(headers.get("x-ratelimit-limit")),
    remaining: parseInteger(headers.get("x-ratelimit-remaining")),
    resetAt: reset === null ? null : new Date(reset * 1000),
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message
    if (typeof message === "string" && message !== "") return message
  }
  return fallback
}

function documentationUrl(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "documentation_url" in body) {
    const url = (body as { documentation_url?: unknown }).documentation_url
    if (typeof url === "string" && url !== "") return url
  }
  return null
}

/**
 * Whether a 403 is quota rather than permissions.
 *
 * GitHub overloads 403 for both, and the two need opposite handling — one is "wait", the other is
 * "this credential will never work". Primary limits announce themselves with
 * `x-ratelimit-remaining: 0`; secondary limits send `retry-after` and say so in the message.
 */
function rateLimitDetails(
  status: number,
  headers: Headers,
  message: string,
  rateLimit: RateLimit,
): { retryAfterSeconds: number; secondary: boolean } | null {
  const retryAfter = parseInteger(headers.get("retry-after"))
  const secondary = message.toLowerCase().includes("secondary rate limit")

  if (retryAfter !== null && (status === 429 || status === 403)) {
    return { retryAfterSeconds: Math.max(0, retryAfter), secondary }
  }

  if ((status === 403 || status === 429) && rateLimit.remaining === 0) {
    const seconds =
      rateLimit.resetAt === null ? 60 : Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000)
    return { retryAfterSeconds: Math.max(0, seconds), secondary }
  }

  if (secondary) return { retryAfterSeconds: 60, secondary: true }

  return null
}

export function throwForResponse(
  status: number,
  path: string,
  headers: Headers,
  body: unknown,
  rateLimit: RateLimit,
): never {
  const message = errorMessage(body, `GitHub returned ${status} for ${path}`)
  const docs = documentationUrl(body)

  const limited = rateLimitDetails(status, headers, message, rateLimit)
  if (limited !== null) {
    throw new GitHubRateLimitError(
      status,
      path,
      message,
      limited.retryAfterSeconds,
      rateLimit.resetAt,
      limited.secondary,
    )
  }

  if (status === 401) throw new GitHubAuthError(status, path, message, docs)
  if (status === 403) throw new GitHubAuthError(status, path, message, docs)
  if (status === 404) throw new GitHubNotFoundError(status, path, message, docs)
  if (status === 422) throw new GitHubValidationError(status, path, message, docs)

  throw new GitHubApiError(status, path, message, docs)
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: GitHubRequest["query"] | undefined,
): string {
  const url = new URL(`${baseUrl}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** The real client. The only place in the package that performs I/O. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const baseUrl = options.baseUrl ?? GITHUB_API
  const userAgent = options.userAgent ?? "SproutOS"
  const doFetch = options.fetch ?? globalThis.fetch

  async function request<T>(input: GitHubRequest): Promise<GitHubResponse<T>> {
    const url = buildUrl(baseUrl, input.path, input.query)

    let response: Response
    try {
      response = await doFetch(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.credential.token}`,
          Accept: input.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": userAgent,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      })
    } catch (cause) {
      throw new GitHubTransportError(input.path, { cause })
    }

    const rateLimit = readRateLimit(response.headers)

    const text = await response.text()
    let body: unknown = null
    if (text !== "") {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }

    if (!response.ok) {
      throwForResponse(response.status, input.path, response.headers, body, rateLimit)
    }

    return { status: response.status, data: body as T, rateLimit }
  }

  return { request }
}
