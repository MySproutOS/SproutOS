import type { GitHubClient } from "./client"
import { GitHubCredentialError } from "./errors"
import type {
  ForkRepositoryInput,
  GenerateFromTemplateInput,
  GitHubCredential,
  GitHubInstallationToken,
  GitHubRepository,
  GitHubUserToken,
  NewRepositoryInput,
} from "./types"

type RawOwner = { login?: unknown; type?: unknown }

type RawRepository = {
  id?: unknown
  node_id?: unknown
  name?: unknown
  full_name?: unknown
  owner?: RawOwner
  private?: unknown
  fork?: unknown
  default_branch?: unknown
  html_url?: unknown
  clone_url?: unknown
  parent?: RawRepository
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * Narrows GitHub's repository payload to the fields the platform stores.
 *
 * `id` and `full_name` are load-bearing — `repository` keys on the numeric id precisely because a
 * login can be renamed and reused by someone else — so a payload missing either is an error
 * rather than a row with a zero in it.
 */
export function toRepository(raw: RawRepository): GitHubRepository {
  const id = typeof raw.id === "number" ? raw.id : Number(raw.id)
  const fullName = optionalString(raw.full_name)

  if (!Number.isFinite(id) || fullName === null) {
    throw new GitHubCredentialError("GitHub returned a repository without an id or a full name")
  }

  const ownerLogin = optionalString(raw.owner?.login) ?? fullName.split("/")[0]
  const ownerType = raw.owner?.type === "Organization" ? "Organization" : "User"
  const parent = raw.parent

  return {
    id,
    nodeId: optionalString(raw.node_id),
    name: optionalString(raw.name) ?? fullName.split("/")[1] ?? fullName,
    fullName,
    ownerLogin,
    ownerType,
    private: raw.private === true,
    fork: raw.fork === true,
    defaultBranch: optionalString(raw.default_branch) ?? "main",
    htmlUrl: optionalString(raw.html_url) ?? `https://github.com/${fullName}`,
    cloneUrl: optionalString(raw.clone_url),
    parent:
      parent === undefined || parent === null
        ? null
        : {
            id: Number(parent.id),
            fullName: optionalString(parent.full_name) ?? "",
            defaultBranch: optionalString(parent.default_branch) ?? "main",
          },
  }
}

function assertUserToken(
  credential: GitHubCredential,
  endpoint: string,
): asserts credential is GitHubUserToken {
  if (credential.kind !== "user") {
    throw new GitHubCredentialError(
      `${endpoint} is not available to GitHub Apps (ADR 0005). It needs the user's OAuth token, ` +
        `read out of \`account\` with @lib/envelope — a "${credential.kind}" credential was passed.`,
    )
  }
}

/**
 * Creates a repository on the **signed-in user's personal account**.
 *
 * `POST /user/repos` is marked `enabledForGitHubApps: false` in GitHub's own OpenAPI description,
 * so this is the one provisioning operation an installation token cannot perform (ADR 0005). The
 * parameter type says so, and the runtime check catches a credential that lost its type crossing
 * a JSON boundary — the failure GitHub would otherwise give is a 403 that reads like a missing
 * permission and sends the reader looking in the wrong place.
 */
export async function createPersonalRepository(
  client: GitHubClient,
  credential: GitHubUserToken,
  input: NewRepositoryInput,
): Promise<GitHubRepository> {
  assertUserToken(credential, "POST /user/repos")

  const response = await client.request<RawRepository>({
    method: "POST",
    path: "/user/repos",
    credential,
    body: {
      name: input.name,
      description: input.description ?? undefined,
      homepage: input.homepage ?? undefined,
      private: input.private ?? true,
      auto_init: input.autoInit ?? false,
    },
  })

  return toRepository(response.data)
}

/**
 * Creates a repository owned by a GitHub organization.
 *
 * Unlike the personal-account route this one is open to installation tokens, so it takes any
 * credential and the caller should prefer the installation's — it has its own 5,000 req/hr budget
 * rather than sharing the user's across everything the platform does as them.
 */
export async function createOrganizationRepository(
  client: GitHubClient,
  credential: GitHubCredential,
  organization: string,
  input: NewRepositoryInput,
): Promise<GitHubRepository> {
  const response = await client.request<RawRepository>({
    method: "POST",
    path: `/orgs/${encodeURIComponent(organization)}/repos`,
    credential,
    body: {
      name: input.name,
      description: input.description ?? undefined,
      homepage: input.homepage ?? undefined,
      private: input.private ?? true,
      auto_init: input.autoInit ?? false,
    },
  })

  return toRepository(response.data)
}

/**
 * Forks an upstream repository. This is the store's fork button.
 *
 * GitHub answers 202 and finishes asynchronously — the repository in the response may not be
 * clonable for a few seconds. That is why project provisioning is a `project_job` and not a
 * request handler.
 */
export async function forkRepository(
  client: GitHubClient,
  credential: GitHubCredential,
  input: ForkRepositoryInput,
): Promise<GitHubRepository> {
  const response = await client.request<RawRepository>({
    method: "POST",
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/forks`,
    credential,
    body: {
      organization: input.organization ?? undefined,
      name: input.name ?? undefined,
      default_branch_only: input.defaultBranchOnly ?? true,
    },
  })

  return toRepository(response.data)
}

/**
 * Creates a repository from a template repository.
 *
 * Unlike a fork this produces an unrelated repository with a single squashed commit, so there is
 * no upstream to track. `repository.provenance` records which of the two happened, because fork
 * upkeep only means anything for the former.
 */
export async function generateFromTemplate(
  client: GitHubClient,
  credential: GitHubCredential,
  input: GenerateFromTemplateInput,
): Promise<GitHubRepository> {
  const owner = encodeURIComponent(input.templateOwner)
  const repo = encodeURIComponent(input.templateRepo)

  const response = await client.request<RawRepository>({
    method: "POST",
    path: `/repos/${owner}/${repo}/generate`,
    credential,
    body: {
      owner: input.owner ?? undefined,
      name: input.name,
      description: input.description ?? undefined,
      private: input.private ?? true,
      include_all_branches: input.includeAllBranches ?? false,
    },
  })

  return toRepository(response.data)
}

export async function getRepository(
  client: GitHubClient,
  credential: GitHubCredential,
  owner: string,
  repo: string,
): Promise<GitHubRepository> {
  const response = await client.request<RawRepository>({
    method: "GET",
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    credential,
  })

  return toRepository(response.data)
}

export type InstallationRepositoryPage = {
  totalCount: number
  repositories: GitHubRepository[]
}

/**
 * The repositories an installation can reach, which is what the "pick a repo" picker shows.
 *
 * Takes an installation token specifically: `/installation/repositories` is scoped to whichever
 * installation minted the credential, so a user token here would 404 in a way that looks like the
 * installation is gone.
 */
export async function listInstallationRepositories(
  client: GitHubClient,
  credential: GitHubInstallationToken,
  options: { page?: number; perPage?: number } = {},
): Promise<InstallationRepositoryPage> {
  const response = await client.request<{
    total_count?: unknown
    repositories?: RawRepository[]
  }>({
    method: "GET",
    path: "/installation/repositories",
    credential,
    query: { page: options.page ?? 1, per_page: options.perPage ?? 100 },
  })

  const repositories = Array.isArray(response.data.repositories) ? response.data.repositories : []

  return {
    totalCount: Number(response.data.total_count ?? repositories.length),
    repositories: repositories.map((raw) => toRepository(raw)),
  }
}
