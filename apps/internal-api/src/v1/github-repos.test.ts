import { describe, expect, it } from "vitest"
import { GitHubNotFoundError } from "@lib/github"
import {
  availableInstallationResults,
  mergeInstallationRepositoryPages,
  repositoryNameProblem,
} from "./github-repos"

describe("mergeInstallationRepositoryPages", () => {
  it("includes repositories from every connected installation and de-duplicates by GitHub id", () => {
    const shared = {
      id: 42,
      nodeId: "R_42",
      name: "shared",
      fullName: "account/shared",
      ownerLogin: "account",
      ownerType: "Organization" as const,
      private: false,
      fork: false,
      defaultBranch: "main",
      htmlUrl: "https://github.com/account/shared",
      cloneUrl: "https://github.com/account/shared.git",
      parent: null,
    }
    const result = mergeInstallationRepositoryPages([
      { repositories: [shared], totalCount: 1 },
      {
        repositories: [
          shared,
          {
            ...shared,
            id: 99,
            name: "personal-fork",
            fullName: "person/personal-fork",
            ownerLogin: "person",
            fork: true,
          },
        ],
        totalCount: 2,
      },
    ])

    expect(result.repositories.map((repository) => repository.id)).toEqual([42, 99])
    expect(result.totalCount).toBe(3)
  })
})

describe("availableInstallationResults", () => {
  it("ignores a removed installation without hiding healthy installations", () => {
    const healthy = { accountLogin: "person", page: { repositories: [], totalCount: 0 } }
    expect(
      availableInstallationResults([
        {
          status: "rejected",
          reason: new GitHubNotFoundError(
            404,
            "/app/installations/stale/access_tokens",
            "Not Found",
          ),
        },
        { status: "fulfilled", value: healthy },
      ]),
    ).toEqual([healthy])
  })
})

/**
 * The rules GitHub enforces, checked before the round trip rather than after the create.
 *
 * A repository is created inside a `project_job`, so GitHub's own complaint about a trailing dot
 * would reach the customer as a failed provision some minutes later, with the name long gone from
 * the form. These are the same rules, applied while it can still be corrected.
 */
describe("repositoryNameProblem", () => {
  it.each(["toyourcredit", "my-app", "my_app", "app.v2", "A1", "x"])("accepts %s", (name) => {
    expect(repositoryNameProblem(name)).toBeNull()
  })

  it.each([
    ["a space", "my app"],
    ["a slash", "owner/repo"],
    ["a colon", "my:app"],
    ["an emoji", "app🎉"],
    ["an accent", "café"],
  ])("refuses %s", (_label, name) => {
    expect(repositoryNameProblem(name)).toMatch(/letters, numbers/)
  })

  /*
    The three GitHub rejects for reasons that are not about the character set. Each returns its own
    sentence: "that name will not work" sends somebody hunting, and naming the rule does not.
  */
  it("refuses the directory names", () => {
    expect(repositoryNameProblem(".")).toMatch(/cannot be named \. or \.\./)
    expect(repositoryNameProblem("..")).toMatch(/cannot be named \. or \.\./)
  })

  it("refuses a .git suffix", () => {
    expect(repositoryNameProblem("thing.git")).toMatch(/cannot end in \.git/)
  })

  it("refuses a trailing dot", () => {
    expect(repositoryNameProblem("thing.")).toMatch(/cannot end in a dot/)
  })

  it("gives a different reason for each kind of problem", () => {
    // A single message for every failure is the thing this function exists to avoid.
    const reasons = new Set(
      ["..", "thing.git", "thing.", "my app"].map((name) => repositoryNameProblem(name)),
    )
    expect(reasons.size).toBe(4)
  })
})
