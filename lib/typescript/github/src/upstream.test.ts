import { describe, expect, it } from "vitest"
import type { GitHubClient } from "./client"
import { installationToken } from "./types"
import { positionFromComparison, repositoryTagState, type RawComparison } from "./upstream"

/**
 * The frame-of-reference flip, pinned.
 *
 * `compareWithUpstream` asks GitHub to compare the fork's branch (base) against upstream's (head),
 * so every number in the reply describes upstream relative to the fork — the opposite of what the
 * rest of the system means by "behind". Get it backwards and a fork with nothing to do is sent to
 * the paid reconciliation path nightly, while a fork that really is behind reports up to date and
 * silently stops receiving updates. Neither failure raises an error.
 */
describe("positionFromComparison", () => {
  it("reads upstream's ahead_by as the fork being behind", () => {
    const raw: RawComparison = {
      status: "ahead",
      ahead_by: 12,
      behind_by: 0,
      commits: [{ sha: "old" }, { sha: "upstream-tip" }],
      files: [{}, {}, {}],
    }

    expect(positionFromComparison(raw)).toEqual({
      behindBy: 12,
      aheadBy: 0,
      status: "behind",
      upstreamSha: "upstream-tip",
      changedFiles: 3,
    })
  })

  it("reads upstream's behind_by as the fork being ahead", () => {
    const position = positionFromComparison({ status: "behind", ahead_by: 0, behind_by: 4 })

    expect(position.behindBy).toBe(0)
    expect(position.aheadBy).toBe(4)
    expect(position.status).toBe("ahead")
  })

  it("leaves identical and diverged alone", () => {
    expect(positionFromComparison({ status: "identical" }).status).toBe("identical")
    expect(positionFromComparison({ status: "diverged" }).status).toBe("diverged")
  })

  it("falls back to the merge base when the fork is not behind", () => {
    // No commits upstream-only, so the merge base is upstream's tip. Recording "" instead would
    // make a clean up-to-date run look like a parse failure.
    const position = positionFromComparison({
      status: "identical",
      commits: [],
      merge_base_commit: { sha: "shared-tip" },
    })

    expect(position.upstreamSha).toBe("shared-tip")
  })

  it("reports zero changed files when GitHub truncates the comparison", () => {
    // A very large diff omits `files` entirely. This must not read as "upstream changed nothing".
    expect(positionFromComparison({ status: "ahead", ahead_by: 900 }).changedFiles).toBe(0)
  })

  it("survives a payload with nothing in it", () => {
    expect(positionFromComparison({})).toEqual({
      behindBy: 0,
      aheadBy: 0,
      status: "",
      upstreamSha: "",
      changedFiles: 0,
    })
  })
})

describe("repositoryTagState", () => {
  const credential = installationToken("test", 1, new Date("2030-01-01T00:00:00Z"))

  function clientFor(pages: unknown[][]): GitHubClient {
    let index = 0
    return {
      request: <T>() =>
        Promise.resolve({
          status: 200,
          data: (pages[index++] ?? []) as T,
          rateLimit: { limit: null, remaining: null, resetAt: null },
        }),
    }
  }

  it("fingerprints the complete tag set independent of response order", async () => {
    const tags = Array.from({ length: 101 }, (_, index) => ({
      name: `v${index}`,
      commit: { sha: index.toString(16).padStart(40, "0") },
    }))
    const first = await repositoryTagState(
      clientFor([tags.slice(0, 100), tags.slice(100)]),
      credential,
      "upstream/app",
    )
    const second = await repositoryTagState(
      clientFor([[...tags].reverse().slice(0, 100), [...tags].reverse().slice(100)]),
      credential,
      "upstream/app",
    )

    expect(first).toEqual(second)
    expect(first.hasTags).toBe(true)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("has a stable empty fingerprint when upstream has no tags", async () => {
    const state = await repositoryTagState(clientFor([[]]), credential, "upstream/app")
    expect(state.hasTags).toBe(false)
    expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})
