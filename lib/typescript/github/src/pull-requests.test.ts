/* oxlint-disable vitest/require-mock-type-parameters -- generic GitHub request mocks preserve the client contract */
import { describe, expect, it, vi } from "vitest"
import type { GitHubClient } from "./client"
import { GitHubValidationError } from "./errors"
import { ensurePullRequest, getPullRequestState } from "./pull-requests"
import { installationToken } from "./types"

const credential = installationToken("test", 1, new Date("2030-01-01T00:00:00Z"))
const input = {
  owner: "customer",
  repo: "app",
  head: "sproutos/upkeep-1",
  base: "main",
  title: "Update",
  body: "Body",
}

function clientFor(statuses: unknown[], combinedState = "pending") {
  return {
    request: vi.fn(({ path }: { path: string }) => {
      const data = path.endsWith("/pulls/7")
        ? { state: "open", merged: false, head: { sha: "a".repeat(40) } }
        : path.endsWith("/check-runs")
          ? {
              check_runs: [{ name: "verify", status: "completed", conclusion: "success" }],
            }
          : { state: combinedState, statuses }
      return Promise.resolve({
        status: 200,
        data,
        rateLimit: { limit: null, remaining: null, resetAt: null },
      })
    }),
  } as unknown as GitHubClient
}

describe("ensurePullRequest", () => {
  it("recovers an already-merged PR instead of creating a duplicate", async () => {
    const requests: unknown[] = []
    const request = vi.fn(<T>(requestInput: unknown) => {
      requests.push(requestInput)
      return Promise.resolve({
        status: 200,
        data: [
          {
            number: 12,
            html_url: "https://github.test/pull/12",
            state: "closed",
            merged_at: "2029-01-01T00:00:00Z",
          },
        ] as T,
        rateLimit: { limit: null, remaining: null, resetAt: null },
      })
    })
    const result = await ensurePullRequest({ request } as GitHubClient, credential, input)
    expect(result.number).toBe(12)
    expect(request).toHaveBeenCalledOnce()
    expect(requests[0]).toMatchObject({ query: { state: "all" } })
  })

  it("refetches the exact PR when another worker wins the create race", async () => {
    let call = 0
    const request = vi.fn(<T>() => {
      call += 1
      if (call === 1)
        return Promise.resolve({
          status: 200,
          data: [] as T,
          rateLimit: { limit: null, remaining: null, resetAt: null },
        })
      if (call === 2)
        return Promise.reject(new GitHubValidationError(422, "/pulls", "already exists"))
      return Promise.resolve({
        status: 200,
        data: [{ number: 13, html_url: "https://github.test/pull/13", state: "open" }] as T,
        rateLimit: { limit: null, remaining: null, resetAt: null },
      })
    })
    const result = await ensurePullRequest({ request } as GitHubClient, credential, input)
    expect(result.number).toBe(13)
    expect(request).toHaveBeenCalledTimes(3)
  })
})

describe("getPullRequestState", () => {
  it("does not let GitHub's empty legacy status channel veto successful checks", async () => {
    const state = await getPullRequestState(clientFor([]), credential, {
      owner: "customer",
      repo: "app",
      number: 7,
    })
    expect(state.checks).toBe("passed")
  })

  it("keeps a real pending legacy status blocking", async () => {
    const state = await getPullRequestState(
      clientFor([{ context: "external-ci", state: "pending" }]),
      credential,
      { owner: "customer", repo: "app", number: 7 },
    )
    expect(state.checks).toBe("pending")
  })
})
