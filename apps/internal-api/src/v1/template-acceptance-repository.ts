import type { GitHubRepository } from "@lib/github"

export type ExpectedAcceptanceRepository = {
  githubRepoId: number
  ownerLogin: string
  repositoryName: string
}

/** Pure identity and policy gate; provider-backed emptiness is checked separately. */
export function acceptanceRepositoryProblem(
  repository: GitHubRepository,
  expected: ExpectedAcceptanceRepository,
): string | undefined {
  const expectedFullName = `${expected.ownerLogin}/${expected.repositoryName}`
  if (
    repository.id !== expected.githubRepoId ||
    repository.fullName.toLowerCase() !== expectedFullName.toLowerCase() ||
    repository.ownerLogin.toLowerCase() !== expected.ownerLogin.toLowerCase() ||
    repository.name.toLowerCase() !== expected.repositoryName.toLowerCase()
  ) {
    return "GitHub repository identity does not match ownerLogin and repositoryName"
  }
  if (!repository.private || repository.archived || repository.fork || repository.parent !== null) {
    return "Production acceptance requires a private, unarchived, non-fork repository"
  }
  return undefined
}
