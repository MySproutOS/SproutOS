import type { GitHubClient } from "./client"
import { GitHubCredentialError } from "./errors"
import type { GitHubCredential } from "./types"

/** Where a fork and the repository it came from can be compared. */
export type CompareTarget = {
  /** The fork, which is the repository the installation is guaranteed to reach. */
  owner: string
  repo: string
  branch: string
  /** The upstream, as `owner/name`. */
  upstreamFullName: string
  upstreamBranch: string
}

/** GitHub's compare payload, narrowed to the fields a decision is made from. */
export type RawComparison = {
  status?: unknown
  ahead_by?: unknown
  behind_by?: unknown
  base_commit?: { sha?: unknown }
  merge_base_commit?: { sha?: unknown }
  /** Commits present in head (upstream) and not in base (the fork), oldest first. */
  commits?: { sha?: unknown }[]
  files?: unknown[]
  total_commits?: unknown
}

/** The fork's position relative to upstream, in the fork's own frame of reference. */
export type UpstreamPosition = {
  behindBy: number
  aheadBy: number
  status: string
  upstreamSha: string
  forkSha: string
  changedFiles: number
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Flip a comparison from upstream's frame of reference into the fork's.
 *
 * This is the single most error-prone line in the upkeep path, so it gets its own function and its
 * own tests. `GET /repos/{owner}/{repo}/compare/{base}...{head}` reports `ahead_by` and `behind_by`
 * describing **head relative to base**. The call is made from the fork with the fork's branch as
 * base and upstream's as head — that direction, rather than the reverse, because an installation
 * token is guaranteed to reach the fork and merely *probably* reaches upstream.
 *
 * So GitHub's `ahead_by` counts commits upstream has that the fork lacks, which is the fork's
 * `behindBy`. Getting this backwards inverts every downstream decision: a fork with nothing to do
 * would be sent to the expensive reconciliation path, and a fork that is genuinely behind would be
 * reported up to date and never updated again.
 */
export function positionFromComparison(raw: RawComparison): Omit<UpstreamPosition, "forkSha"> {
  // GitHub's `status` also describes head (upstream) relative to base (the fork).
  const inverted: Record<string, string> = {
    ahead: "behind",
    behind: "ahead",
    identical: "identical",
    diverged: "diverged",
  }
  const reported = typeof raw.status === "string" ? raw.status : ""

  return {
    behindBy: count(raw.ahead_by),
    aheadBy: count(raw.behind_by),
    status: inverted[reported] ?? reported,
    upstreamSha: upstreamTip(raw),
    // `files` is capped at 300 and omitted entirely on very large comparisons. Reporting 0 for a
    // truncated response is deliberate: the decision path treats it as "unknown", never "none".
    changedFiles: Array.isArray(raw.files) ? raw.files.length : 0,
  }
}

/**
 * Upstream's tip commit, which the compare payload does not name directly.
 *
 * There is no `head_commit` field. `commits` holds what head has and base does not, oldest first,
 * so its last entry is upstream's tip. When the fork is not behind, that array is empty and the
 * merge base *is* upstream's tip — the two branches meet there. Falling back to the merge base
 * rather than to an empty string matters: the sha is recorded against the run, and `""` would make
 * a successful up-to-date check indistinguishable from one that failed to parse.
 */
function upstreamTip(raw: RawComparison): string {
  const commits = Array.isArray(raw.commits) ? raw.commits : []
  const tip = commits.at(-1)?.sha

  if (typeof tip === "string" && tip !== "") return tip

  return typeof raw.merge_base_commit?.sha === "string" ? raw.merge_base_commit.sha : ""
}

/**
 * How far a fork has drifted from the repository it came from.
 *
 * Compared from the fork's side. The `owner:repo:branch` head syntax is what makes a cross-repository
 * comparison possible without holding a credential for the other repository.
 */
export async function compareWithUpstream(
  client: GitHubClient,
  credential: GitHubCredential,
  target: CompareTarget,
): Promise<UpstreamPosition> {
  const [upstreamOwner, upstreamRepo] = target.upstreamFullName.split("/")

  if (upstreamOwner === undefined || upstreamRepo === undefined) {
    throw new GitHubCredentialError(
      `Upstream "${target.upstreamFullName}" is not in owner/name form`,
    )
  }

  const basehead = `${target.branch}...${upstreamOwner}:${upstreamRepo}:${target.upstreamBranch}`

  const response = await client.request<RawComparison>({
    method: "GET",
    path: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/compare/${basehead}`,
    credential,
  })

  return {
    ...positionFromComparison(response.data),
    forkSha:
      typeof response.data.base_commit?.sha === "string" ? response.data.base_commit.sha : "",
  }
}

export type SyncResult = {
  /** GitHub's own word for what it did: "fast-forward", "merge", or "none". */
  mergeType: string
  baseBranch: string
  message: string
}

/**
 * Pull upstream's commits into the fork's branch, server-side.
 *
 * `merge-upstream` is GitHub's dedicated fork-sync endpoint. Using it rather than a clone, a merge
 * and a push means no runner, no checkout, and nothing to bill the customer for on the cheap path
 * — which is the entire reason `decideUpkeepAction` separates a fast-forward from a reconciliation.
 *
 * It refuses rather than forces when the branches have genuinely diverged, and that refusal is the
 * caller's signal to take the expensive path.
 */
export async function syncWithUpstream(
  client: GitHubClient,
  credential: GitHubCredential,
  owner: string,
  repo: string,
  branch: string,
): Promise<SyncResult> {
  const response = await client.request<{
    merge_type?: unknown
    base_branch?: unknown
    message?: unknown
  }>({
    method: "POST",
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/merge-upstream`,
    credential,
    body: { branch },
  })

  return {
    mergeType: typeof response.data.merge_type === "string" ? response.data.merge_type : "none",
    baseBranch: typeof response.data.base_branch === "string" ? response.data.base_branch : branch,
    message: typeof response.data.message === "string" ? response.data.message : "",
  }
}
