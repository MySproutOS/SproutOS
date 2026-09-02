import type { GitHubRepository } from "@lib/github"
import { describe, expect, it } from "vitest"
import { acceptanceRepositoryProblem } from "./template-acceptance-repository"

const repository: GitHubRepository = {
  id: 123,
  nodeId: "R_test",
  name: "acceptance",
  fullName: "TestSproutOS/acceptance",
  ownerLogin: "TestSproutOS",
  ownerType: "Organization",
  private: true,
  fork: false,
  archived: false,
  defaultBranch: "main",
  htmlUrl: "https://github.com/TestSproutOS/acceptance",
  cloneUrl: "https://github.com/TestSproutOS/acceptance.git",
  parent: null,
}

const expected = {
  githubRepoId: repository.id,
  ownerLogin: repository.ownerLogin,
  repositoryName: repository.name,
}

describe("precreated acceptance repository policy", () => {
  it("accepts only the exact private ordinary repository", () => {
    expect(acceptanceRepositoryProblem(repository, expected)).toBeUndefined()
    expect(acceptanceRepositoryProblem({ ...repository, id: 124 }, expected)).toContain("identity")
    expect(
      acceptanceRepositoryProblem({ ...repository, fullName: "Other/acceptance" }, expected),
    ).toContain("identity")
  })

  it.each([
    ["public", { private: false }],
    ["archived", { archived: true }],
    ["fork", { fork: true }],
    ["parented", { parent: { id: 1, fullName: "upstream/project", defaultBranch: "main" } }],
  ])("rejects a %s repository", (_label, change) => {
    expect(acceptanceRepositoryProblem({ ...repository, ...change }, expected)).toContain(
      "private, unarchived, non-fork",
    )
  })
})
