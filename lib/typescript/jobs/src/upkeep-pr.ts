import { crudUpstreamSyncRun } from "@lib/dao"
import {
  createGitHubClient,
  createInstallationTokenStore,
  deleteBranch,
  envAppJwtSigner,
  getPullRequestState,
  GitHubApiError,
  mergePullRequest,
  type GitHubClient,
  type GitHubCredential,
  type InstallationTokenRequest,
} from "@lib/github"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

export const UPKEEP_PR_KIND = "upkeep.finalize_pr"
const POLL_MS = 60_000
const TIMEOUT_MS = 2 * 60 * 60 * 1000

export type UpkeepPrPayload = { upstreamSyncRunId: string; poll?: number; deadline?: string }

export type UpkeepPrDeps = {
  client: GitHubClient
  credentialFor: (
    installationId: number,
    request: InstallationTokenRequest,
  ) => Promise<GitHubCredential>
}

let defaults: UpkeepPrDeps | null = null
function defaultDeps(): UpkeepPrDeps {
  if (defaults === null) {
    const client = createGitHubClient()
    const tokens = createInstallationTokenStore({ client, signJwt: envAppJwtSigner() })
    defaults = { client, credentialFor: (id, request) => tokens.get(id, request) }
  }
  return defaults
}

export async function enqueueUpkeepPrFinalizer(
  db: Parameters<typeof enqueue>[0],
  upstreamSyncRunId: string,
  input: { poll?: number; deadline?: Date; runAt?: Date } = {},
): Promise<string> {
  const poll = input.poll ?? 0
  const deadline = input.deadline ?? new Date(Date.now() + TIMEOUT_MS)
  return enqueue(db, {
    kind: UPKEEP_PR_KIND,
    payload: { upstreamSyncRunId, poll, deadline: deadline.toISOString() },
    runAt: input.runAt,
    maxAttempts: 10,
    idempotencyKey: `${UPKEEP_PR_KIND}:${upstreamSyncRunId}:${poll}`,
  })
}

/** Poll CI, then let GitHub's protected-branch merge endpoint make the final authorization decision. */
export function finalizeUpkeepPullRequest(deps?: UpkeepPrDeps): JobHandler {
  return async (job, { db }) => {
    const payload = job.payload as UpkeepPrPayload
    const poll = payload.poll ?? 0
    const deadline =
      payload.deadline === undefined
        ? new Date(Date.now() + TIMEOUT_MS)
        : new Date(payload.deadline)
    const row = await db
      .selectFrom("upstreamSyncRun")
      .innerJoin("repository", "repository.id", "upstreamSyncRun.repositoryId")
      .innerJoin("githubInstallation", "githubInstallation.id", "repository.githubInstallationId")
      .select([
        "upstreamSyncRun.id",
        "upstreamSyncRun.outcome",
        "upstreamSyncRun.pullRequestNumber",
        "upstreamSyncRun.branch",
        "upstreamSyncRun.forkSha",
        "repository.id as repositoryId",
        "repository.ownerLogin",
        "repository.name",
        "repository.githubRepoId",
        "githubInstallation.installationId",
      ])
      .where("upstreamSyncRun.id", "=", payload.upstreamSyncRunId)
      .executeTakeFirst()
    if (row === undefined || row.outcome !== "pr_opened" || row.pullRequestNumber === null) return

    const wired = deps ?? defaultDeps()
    const credential = await wired.credentialFor(Number(row.installationId), {
      purpose: "upkeep-pr-finalize",
      repositoryId: Number(row.githubRepoId),
    })
    const input = { owner: row.ownerLogin, repo: row.name, number: row.pullRequestNumber }
    const state = await getPullRequestState(wired.client, credential, input)
    if (state.merged) {
      await markMerged(
        db,
        row.id,
        row.repositoryId,
        wired,
        credential,
        row.ownerLogin,
        row.name,
        row.branch,
      )
      return
    }
    if (
      state.state === "closed" ||
      (row.forkSha !== null && state.headSha !== row.forkSha) ||
      state.checks === "failed" ||
      Date.now() >= deadline.getTime()
    ) {
      await crudUpstreamSyncRun(db).update(row.id, { outcome: "failed" })
      return
    }

    // Give Actions one poll to register. Thereafter GitHub branch protection remains authoritative:
    // the merge API refuses while required checks or reviews are pending.
    if (poll > 0 && state.checks === "passed") {
      try {
        const merge = await mergePullRequest(wired.client, credential, {
          ...input,
          headSha: state.headSha,
        })
        if (merge.merged) {
          await markMerged(
            db,
            row.id,
            row.repositoryId,
            wired,
            credential,
            row.ownerLogin,
            row.name,
            row.branch,
          )
          return
        }
      } catch (error) {
        // Required reviews and merge queues can still block after CI passes. Keep polling the
        // durable PR instead of consuming this background job's retry budget in a tight loop.
        if (!(error instanceof GitHubApiError) || ![405, 409].includes(error.status)) throw error
      }
    }

    await enqueueUpkeepPrFinalizer(db, row.id, {
      poll: poll + 1,
      deadline,
      runAt: new Date(Date.now() + POLL_MS),
    })
  }
}

async function markMerged(
  db: Parameters<typeof enqueue>[0],
  runId: string,
  repositoryId: string,
  deps: UpkeepPrDeps,
  credential: GitHubCredential,
  owner: string,
  repo: string,
  branch: string,
) {
  await deleteBranch(deps.client, credential, { owner, repo, branch })
  await db.transaction().execute(async (trx) => {
    await crudUpstreamSyncRun(trx).update(runId, { outcome: "merged" })
    await trx
      .updateTable("repository")
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", repositoryId)
      .execute()
  })
}
