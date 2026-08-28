import type { GitHubClient } from "./client"
import { GitHubCredentialError, GitHubValidationError } from "./errors"
import type { GitHubCredential } from "./types"

export type PullRequestResult = { number: number; url: string }

type RawPullRequest = { number?: unknown; html_url?: unknown }

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
    return existing.data[0]
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
