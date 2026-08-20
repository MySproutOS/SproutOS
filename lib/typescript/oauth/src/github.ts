import { OAuth2Client } from "./client"
import { OAuth2ResponseError } from "./errors"

const GITHUB_ENDPOINTS = {
  authorization: "https://github.com/login/oauth/authorize",
  token: "https://github.com/login/oauth/access_token",
} as const

const GITHUB_API = "https://api.github.com"

/**
 * Scopes requested at sign-in.
 *
 * Identity only. Repository access is escalated later, per project, through the
 * GitHub App installation — asking for `repo` at the front door would mean every
 * visitor grants blanket access to every private repository they can see just to
 * look at a dashboard.
 *
 * `user:email` is needed because a GitHub account's primary address is not
 * necessarily public, and `GET /user` returns `email: null` when it is not.
 */
export const GITHUB_IDENTITY_SCOPES = ["read:user", "user:email"] as const

/**
 * Scopes escalated when a user first connects a repository (TASK 9's step-up).
 *
 * `repo` is unavoidably coarse — GitHub has no finer-grained OAuth App scope —
 * which is exactly why the GitHub App carries the headless work and this token
 * is only used for actions the user themselves initiated.
 */
export const GITHUB_REPOSITORY_SCOPES = ["read:user", "user:email", "repo", "read:org"] as const

/**
 * Build the GitHub OAuth App client from the environment.
 *
 * A function rather than a module-level constant so the values are read after
 * the process has loaded its `.env`, and so a missing variable fails at the
 * point of use with a clear message.
 *
 * This is the **OAuth App**, used for identity and for repository actions the
 * user initiates. The GitHub App — which cannot create a repository on a
 * personal account, since `POST /user/repos` is not available to it — handles
 * headless work under its own credentials.
 */
export function githubOAuthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
    redirectUri: `${requireEnv("NEXT_PUBLIC_HOST_URL")}/login/github/callback`,
    endpoints: GITHUB_ENDPOINTS,
  })
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * The GitHub user fields we rely on.
 *
 * `id` is the stable account identifier and the one to key `account` on. A login
 * can be renamed and reused by someone else; the numeric id cannot.
 */
export interface GitHubUser {
  readonly id: string
  readonly login: string
  readonly name: string | null
  readonly avatarUrl: string | null
  readonly email: string
}

interface GitHubEmail {
  readonly email: string
  readonly primary: boolean
  readonly verified: boolean
}

/**
 * Fetch the signed-in user's profile and a usable email address.
 *
 * GitHub has no ID token, so unlike the Google provider this is a real API call
 * rather than a JWT decode.
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const profile = await githubApi<Record<string, unknown>>("/user", accessToken)

  const id = profile.id
  const login = profile.login
  if (typeof id !== "number" && typeof id !== "string") {
    throw new OAuth2ResponseError("GitHub user response is missing 'id'")
  }
  if (typeof login !== "string" || login === "") {
    throw new OAuth2ResponseError("GitHub user response is missing 'login'")
  }

  const email =
    typeof profile.email === "string" && profile.email !== ""
      ? profile.email
      : await fetchPrimaryEmail(accessToken)

  return {
    id: String(id),
    login,
    name: typeof profile.name === "string" && profile.name !== "" ? profile.name : null,
    avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
    email,
  }
}

/**
 * Resolve an address when the profile's is private.
 *
 * Only a verified address is acceptable: an unverified one proves nothing about
 * who controls it, and we key nothing on email anyway — it is for contacting the
 * user, not identifying them.
 */
async function fetchPrimaryEmail(accessToken: string): Promise<string> {
  const emails = await githubApi<GitHubEmail[]>("/user/emails", accessToken)
  if (!Array.isArray(emails)) {
    throw new OAuth2ResponseError("GitHub email response was not a list")
  }

  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
  if (!primary) {
    throw new OAuth2ResponseError("GitHub account has no verified email address")
  }
  return primary.email
}

async function githubApi<T>(path: string, accessToken: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SproutOS",
      },
    })
  } catch (cause) {
    throw new OAuth2ResponseError(`Could not reach the GitHub API (${path})`, null, { cause })
  }

  if (!response.ok) {
    throw new OAuth2ResponseError(`GitHub API returned an error for ${path}`, response.status)
  }

  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new OAuth2ResponseError(`GitHub API did not return JSON for ${path}`, response.status, {
      cause,
    })
  }
}
