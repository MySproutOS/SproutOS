/**
 * A token minted for the signed-in user by the **OAuth App**.
 *
 * The only credential that can create a repository on a personal account, because
 * `POST /user/repos` is not available to GitHub Apps (ADR 0005). Shared 5,000 req/hr budget
 * across everything the platform does as that user, which is why it is reserved for operations
 * the user initiated.
 */
export type GitHubUserToken = {
  readonly kind: "user"
  readonly token: string
}

/**
 * A `ghs_` installation token from the **GitHub App**. One hour, 5,000 req/hr per installation.
 *
 * `expiresAt` travels with the token so a cache can refuse to hand out one that is about to die
 * mid-request.
 */
export type GitHubInstallationToken = {
  readonly kind: "installation"
  readonly token: string
  readonly installationId: number
  readonly expiresAt: Date
}

/** The app's own RS256 JWT. Valid only for `/app/*` endpoints, ten minutes at most. */
export type GitHubAppJwt = {
  readonly kind: "app"
  readonly token: string
}

export type GitHubCredential = GitHubUserToken | GitHubInstallationToken | GitHubAppJwt

export function userToken(token: string): GitHubUserToken {
  return { kind: "user", token }
}

export function installationToken(
  token: string,
  installationId: number,
  expiresAt: Date,
): GitHubInstallationToken {
  return { kind: "installation", token, installationId, expiresAt }
}

export function appJwt(token: string): GitHubAppJwt {
  return { kind: "app", token }
}

/** What `x-ratelimit-*` said on the response that carried it. */
export type RateLimit = {
  readonly limit: number | null
  readonly remaining: number | null
  readonly resetAt: Date | null
}

/**
 * The repository fields the platform stores.
 *
 * A deliberate subset: `repository` in the database keys on `github_repo_id` because a login can
 * be renamed and reused by someone else, and everything else here is either display metadata or
 * the upstream link that fork upkeep needs.
 */
export type GitHubRepository = {
  readonly id: number
  readonly nodeId: string | null
  readonly name: string
  readonly fullName: string
  readonly ownerLogin: string
  readonly ownerType: "User" | "Organization"
  readonly private: boolean
  readonly fork: boolean
  readonly defaultBranch: string
  readonly htmlUrl: string
  readonly cloneUrl: string | null
  readonly parent: {
    readonly id: number
    readonly fullName: string
    readonly defaultBranch: string
  } | null
}

export type NewRepositoryInput = {
  readonly name: string
  readonly description?: string | null
  readonly private?: boolean
  readonly autoInit?: boolean
  readonly homepage?: string | null
}

export type ForkRepositoryInput = {
  readonly owner: string
  readonly repo: string
  /** The account that receives the fork. Omit for the token holder's own account. */
  readonly organization?: string | null
  readonly name?: string | null
  /** `true` copies only the default branch, which is what a store fork wants. */
  readonly defaultBranchOnly?: boolean
}

export type GenerateFromTemplateInput = {
  readonly templateOwner: string
  readonly templateRepo: string
  readonly name: string
  /** The account that receives the new repository. Omit for the token holder's own account. */
  readonly owner?: string | null
  readonly description?: string | null
  readonly private?: boolean
  readonly includeAllBranches?: boolean
}
