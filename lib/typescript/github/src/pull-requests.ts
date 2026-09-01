import type { GitHubClient } from "./client"
import { GitHubCredentialError, GitHubNotFoundError, GitHubValidationError } from "./errors"
import type { GitHubCredential } from "./types"

export type PullRequestResult = { number: number; url: string }

export type PullRequestState = {
  state: "open" | "closed"
  merged: boolean
  headSha: string
  checks: "pending" | "failed" | "passed" | "none"
}

type RawPullRequest = {
  number?: unknown
  html_url?: unknown
  state?: unknown
  merged_at?: unknown
}

/** Find-or-create makes a retry after a successful POST idempotent. */
export async function ensurePullRequest(
  client: GitHubClient,
  credential: GitHubCredential,
  input: {
    owner: string
    repo: string
    head: string
    base: string
    title: string
    body: string
  },
): Promise<PullRequestResult> {
  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`
  const findExisting = async () => {
    const existing = await client.request<RawPullRequest[]>({
      method: "GET",
      path,
      credential,
      query: { state: "all", head: `${input.owner}:${input.head}`, base: input.base, per_page: 10 },
    })
    return existing.data.find((pull) => pull.state === "open" || typeof pull.merged_at === "string")
  }
  const found = await findExisting()
  if (found !== undefined) return parse(found)

  try {
    const created = await client.request<RawPullRequest>({
      method: "POST",
      path,
      credential,
      body: { title: input.title, body: input.body, head: input.head, base: input.base },
    })
    return parse(created.data)
  } catch (error) {
    // Another worker may have won the GET/POST race. GitHub reports that as 422; recover the
    // exact head/base PR rather than creating another branch or failing an otherwise-complete job.
    if (!(error instanceof GitHubValidationError)) throw error
    const raced = await findExisting()
    if (raced === undefined) throw error
    return parse(raced)
  }
}

function parse(value: RawPullRequest): PullRequestResult {
  if (typeof value.number !== "number" || typeof value.html_url !== "string") {
    throw new GitHubCredentialError("GitHub returned a pull request without a number or URL")
  }
  return { number: value.number, url: value.html_url }
}

export async function ensureBranch(
  client: GitHubClient,
  credential: GitHubCredential,
  input: { owner: string; repo: string; branch: string; sha: string },
): Promise<void> {
  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs/heads/${encodeURIComponent(input.branch)}`
  try {
    await client.request({ method: "GET", path, credential })
    return
  } catch (error) {
    if (!(error instanceof GitHubNotFoundError)) throw error
  }

  try {
    await client.request({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs`,
      credential,
      body: { ref: `refs/heads/${input.branch}`, sha: input.sha },
    })
  } catch (error) {
    // A retry racing another worker sees the branch created between GET and POST.
    if (!(error instanceof GitHubValidationError)) throw error
  }
}

export async function deleteBranch(
  client: GitHubClient,
  credential: GitHubCredential,
  input: { owner: string; repo: string; branch: string },
): Promise<void> {
  try {
    await client.request({
      method: "DELETE",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs/heads/${encodeURIComponent(input.branch)}`,
      credential,
    })
  } catch (error) {
    if (!(error instanceof GitHubNotFoundError)) throw error
  }
}

type RawPullRequestState = {
  state?: unknown
  merged?: unknown
  head?: { sha?: unknown }
}
type RawCheckRuns = {
  total_count?: unknown
  check_runs?: Array<{ status?: unknown; conclusion?: unknown }>
}
type RawCombinedStatus = { state?: unknown; statuses?: unknown[] }

export async function getPullRequestState(
  client: GitHubClient,
  credential: GitHubCredential,
  input: { owner: string; repo: string; number: number },
): Promise<PullRequestState> {
  const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  const pull = await client.request<RawPullRequestState>({
    method: "GET",
    path: `${root}/pulls/${input.number}`,
    credential,
  })
  const state = pull.data.state
  const headSha = pull.data.head?.sha
  if ((state !== "open" && state !== "closed") || typeof headSha !== "string") {
    throw new GitHubCredentialError("GitHub returned an invalid pull request state")
  }

  const [runs, status] = await Promise.all([
    client.request<RawCheckRuns>({
      method: "GET",
      path: `${root}/commits/${headSha}/check-runs`,
      credential,
      query: { per_page: 100 },
    }),
    client.request<RawCombinedStatus>({
      method: "GET",
      path: `${root}/commits/${headSha}/status`,
      credential,
    }),
  ])
  const checkRuns = Array.isArray(runs.data.check_runs) ? runs.data.check_runs : []
  const statuses = Array.isArray(status.data.statuses) ? status.data.statuses : []
  const anyFailed =
    checkRuns.some(
      (run) =>
        run.status === "completed" &&
        !["success", "neutral", "skipped"].includes(String(run.conclusion)),
    ) ||
    status.data.state === "failure" ||
    status.data.state === "error"
  /*
    GitHub reports the combined legacy status as "pending" when there are no status contexts.
    That empty channel must not veto successful Checks API runs forever; an actual status context
    that is pending still blocks.
  */
  const anyPending =
    checkRuns.some((run) => run.status !== "completed") ||
    (statuses.length > 0 && status.data.state === "pending")
  const count = checkRuns.length + statuses.length

  return {
    state,
    merged: pull.data.merged === true,
    headSha,
    checks: anyFailed ? "failed" : anyPending ? "pending" : count === 0 ? "none" : "passed",
  }
}

export async function mergePullRequest(
  client: GitHubClient,
  credential: GitHubCredential,
  input: { owner: string; repo: string; number: number; headSha: string },
): Promise<{ merged: boolean; message: string }> {
  const response = await client.request<{ merged?: unknown; message?: unknown }>({
    method: "PUT",
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.number}/merge`,
    credential,
    body: { sha: input.headSha, merge_method: "merge" },
  })
  return {
    merged: response.data.merged === true,
    message:
      typeof response.data.message === "string"
        ? response.data.message
        : "GitHub declined the merge",
  }
}
