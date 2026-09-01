import {
  crudAgentSession,
  crudProjectJob,
  fetchUpkeepStatus,
  initialSteps,
  recordUpkeepRun,
} from "@lib/dao"
import {
  compareWithUpstream,
  createGitHubClient,
  createInstallationTokenStore,
  deleteBranch,
  ensureBranch,
  ensurePullRequest,
  envAppJwtSigner,
  getBranchHeadSha,
  GitHubApiError,
  type GitHubClient,
  type GitHubCredential,
  type InstallationTokenRequest,
  syncWithUpstream,
} from "@lib/github"
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { decideUpkeepAction, upkeepBranchName } from "./upkeep-decision"
import { enqueueUpkeepPrFinalizer } from "./upkeep-pr"
import { enqueue } from "./queue"
import { UPKEEP_RESOLUTION_KIND } from "./upkeep-resolution"
import type { JobHandler } from "./worker"
import {
  reconcileTemplateUpstream,
  type TemplateUpstreamInput,
  type TemplateUpstreamResult,
} from "./template-upstream"

export type UpkeepPayload = {
  repositoryId: string
  requestedProjectId?: string
  requestedByUserId?: string
}

/**
 * What the handler needs from GitHub, as an argument rather than a global.
 *
 * The default wiring reads the app's private key from the environment and mints installation
 * tokens, which is correct in production and untestable everywhere else. Passing these in is what
 * lets the handler be driven end to end against a stub — and this handler is precisely the kind
 * that has to be, because its failure mode is doing nothing quietly.
 */
export type UpkeepDeps = {
  client: GitHubClient
  credentialFor: (
    installationId: number,
    request: InstallationTokenRequest,
  ) => Promise<GitHubCredential>
  reconcileTemplate?: (input: TemplateUpstreamInput) => Promise<TemplateUpstreamResult>
}

/**
 * One token store per process, for the same reason the API keeps one: an installation token lasts
 * an hour, and a nightly scan over a few hundred forks would otherwise re-authenticate per fork.
 */
let defaults: UpkeepDeps | null = null

function defaultDeps(): UpkeepDeps {
  if (defaults === null) {
    const client = createGitHubClient()
    // `envAppJwtSigner()` reads the key lazily, so building this does not require the key to
    // exist until a job actually runs.
    const tokens = createInstallationTokenStore({ client, signJwt: envAppJwtSigner() })
    defaults = { client, credentialFor: (id, request) => tokens.get(id, request) }
  }
  return defaults
}

/** Every project on this repository that asked for automatic updates. */
async function subscribedProjects(db: Kysely<DB>, repositoryId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("project")
    .select("id")
    .where("repositoryId", "=", repositoryId)
    .where("autoUpdateEnabled", "=", true)
    .where("deletedAt", "is", null)
    .execute()

  return rows.map((row) => row.id)
}

async function startConflictResolution(
  db: Kysely<DB>,
  input: {
    runId: string
    repositoryId: string
    upstreamSha: string
    forkSha: string
    requestedProjectId?: string
    requestedByUserId?: string
  },
) {
  const project = await db
    .selectFrom("project")
    .innerJoin("organization", "organization.id", "project.organizationId")
    .select(["project.id", "project.organizationId", "organization.ownerUserId"])
    .where("project.repositoryId", "=", input.repositoryId)
    .where("project.deletedAt", "is", null)
    .$if(input.requestedProjectId !== undefined, (query) =>
      query.where("project.id", "=", input.requestedProjectId!),
    )
    .orderBy("project.autoUpdateEnabled", "desc")
    .orderBy("project.id", "asc")
    .executeTakeFirst()
  if (project === undefined) return
  const userId = input.requestedByUserId ?? project.ownerUserId
  const key = `upkeep.resolve:${input.runId}`
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(trx)
    const existing = await trx
      .selectFrom("projectJob")
      .select("id")
      .where("idempotencyKey", "=", key)
      .executeTakeFirst()
    if (existing !== undefined) return
    const session = await crudAgentSession(trx).createSession({
      projectId: project.id,
      createdByUserId: userId,
      title: `Resolve upstream conflict ${input.upstreamSha.slice(0, 12)}`,
    })
    const job = await crudProjectJob(trx).enqueueOnce({
      kind: "sync_upstream",
      organizationId: project.organizationId,
      projectId: project.id,
      repositoryId: input.repositoryId,
      state: "queued",
      steps: JSON.stringify(initialSteps("sync_upstream")),
      idempotencyKey: key,
      details: {
        upstreamSyncRunId: input.runId,
        expectedUpstreamSha: input.upstreamSha,
        expectedTargetSha: input.forkSha,
        agentSessionId: session.id,
        userId,
      },
    })
    if (job === undefined) throw new Error("upkeep conflict resolution was not serialized")
    await enqueue(trx, {
      kind: UPKEEP_RESOLUTION_KIND,
      organizationId: project.organizationId,
      payload: { projectJobId: job.id },
      idempotencyKey: `${UPKEEP_RESOLUTION_KIND}:${input.runId}`,
      maxAttempts: 3,
    })
  })
}

/**
 * Reconcile one fork with the repository it came from (TASK 27).
 *
 * Fanned out by `upkeep.scan`, one job per repository rather than per project, because several
 * projects can share a fork and reconciling it three times would bill three times for one merge.
 *
 * Three outcomes, and which one happens is decided by `decideUpkeepAction` from the comparison
 * alone:
 *
 *  - **Nothing to do.** Recorded anyway. `fetchUpkeepStatus` reads this history to decide whether
 *    upkeep is paused, and skipping the boring rows would make a repository that failed once and
 *    then had four quiet nights look like it had failed five times running.
 *  - **A fast-forward.** Done server-side through GitHub's `merge-upstream` on a proposal branch,
 *    then merged only after the repository's CI and branch protection accept the pull request.
 *  - **A real reconciliation.** Attempted as a server-side merge first, since GitHub resolves
 *    everything that is not a genuine textual conflict for free. What comes back as a conflict is
 *    raised to each subscribed project and automatically handed to the bounded conflict agent.
 */
export function upkeepRepository(deps?: UpkeepDeps): JobHandler {
  return async (job, context) => {
    const { db } = context
    const { repositoryId, requestedProjectId, requestedByUserId } = job.payload as UpkeepPayload

    const repository = await db
      .selectFrom("repository")
      .select([
        "id",
        "ownerLogin",
        "name",
        "defaultBranch",
        "provenance",
        "upstreamStrategy",
        "upstreamFullName",
        "upstreamDefaultBranch",
        "githubInstallationId",
        "githubRepoId",
      ])
      .where("id", "=", repositoryId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    // Deleted between the scan and the run. Not an error, and recording a failure against a row that
    // no longer exists would be one.
    if (repository === undefined) return
    if (repository.upstreamFullName === null) return

    // The scan filters paused repositories, but a job enqueued last night can run after tonight's
    // fifth failure. Checking here is what makes the limit a limit.
    const status = await fetchUpkeepStatus(db).forRepository(repositoryId)
    if (status.paused) {
      console.info(`[upkeep] ${repository.ownerLogin}/${repository.name} is paused, skipping`)
      return
    }

    const installation =
      repository.githubInstallationId === null
        ? undefined
        : await db
            .selectFrom("githubInstallation")
            .select("installationId")
            .where("id", "=", repository.githubInstallationId)
            .executeTakeFirst()

    if (installation === undefined) {
      // No installation means no credential, and that will not fix itself on a retry. Recorded as a
      // failure so five of them pause the repository instead of retrying nightly forever.
      await recordUpkeepRun(db).record({
        repositoryId,
        branch: repository.defaultBranch,
        outcome: "failed",
      })
      return
    }

    const { client, credentialFor } = deps ?? defaultDeps()
    const installationId = Number(installation.installationId)
    const githubRepoId = Number(repository.githubRepoId)
    const inspectionCredential = await credentialFor(installationId, {
      purpose: "upkeep-inspect",
      repositoryId: githubRepoId,
    })

    if (repository.upstreamStrategy !== "github_fork") {
      const writeCredential = await credentialFor(installationId, {
        purpose: "upkeep-sync",
        repositoryId: githubRepoId,
      })
      const base = await db
        .selectFrom("upstreamSyncRun")
        .select("upstreamSha")
        .where("repositoryId", "=", repositoryId)
        .where((eb) =>
          eb.or([
            eb.and([eb("branch", "=", repository.defaultBranch), eb("outcome", "=", "up_to_date")]),
            eb("outcome", "=", "merged"),
          ]),
        )
        .where("upstreamSha", "is not", null)
        .orderBy("id", "desc")
        .executeTakeFirst()

      let result: TemplateUpstreamResult
      const [upstreamOwner, upstreamRepo] = repository.upstreamFullName.split("/")
      if (upstreamOwner === undefined || upstreamRepo === undefined) {
        throw new Error(`invalid upstream repository ${repository.upstreamFullName}`)
      }
      const expectedUpstreamSha = await getBranchHeadSha(
        client,
        inspectionCredential,
        upstreamOwner,
        upstreamRepo,
        repository.upstreamDefaultBranch ?? repository.defaultBranch,
      )
      const updateBranch = upkeepBranchName(expectedUpstreamSha)
      try {
        result = await (deps?.reconcileTemplate ?? reconcileTemplateUpstream)({
          owner: repository.ownerLogin,
          repo: repository.name,
          branch: repository.defaultBranch,
          updateBranch,
          upstreamFullName: repository.upstreamFullName,
          upstreamBranch: repository.upstreamDefaultBranch ?? repository.defaultBranch,
          expectedUpstreamSha,
          token: writeCredential.token,
          baseUpstreamSha: base?.upstreamSha,
          signal: context.signal,
        })
      } catch (error) {
        await recordUpkeepRun(db).record({
          repositoryId,
          branch: repository.defaultBranch,
          outcome: "failed",
        })
        throw error
      }

      if (result.outcome === "conflict") {
        const run = await recordUpkeepRun(db).record({
          repositoryId,
          branch: repository.defaultBranch,
          outcome: "conflict",
          upstreamSha: result.upstreamSha,
          forkSha: result.targetSha,
          behindBy: result.behindBy,
          aheadBy: result.aheadBy,
          mergeType: null,
        })
        await recordUpkeepRun(db).suggestToProjects(
          run.id,
          await subscribedProjects(db, repositoryId),
          `${repository.upstreamFullName} conflicts with local changes in: ${result.conflicts.join(", ")}.`,
        )
        await startConflictResolution(db, {
          runId: run.id,
          repositoryId,
          upstreamSha: result.upstreamSha,
          forkSha: result.targetSha,
          requestedProjectId,
          requestedByUserId,
        })
        return
      }

      if (result.outcome === "up_to_date") {
        await recordUpkeepRun(db).record({
          repositoryId,
          branch: repository.defaultBranch,
          outcome: "up_to_date",
          upstreamSha: result.upstreamSha,
          forkSha: result.targetSha,
          behindBy: result.behindBy,
          aheadBy: result.aheadBy,
          mergeType: "none",
        })
      } else if (result.outcome === "merged") {
        const branch = upkeepBranchName(result.upstreamSha)
        if (branch !== updateBranch)
          throw new Error("template upkeep branch was not derived from upstream SHA")
        const pr = await ensurePullRequest(client, writeCredential, {
          owner: repository.ownerLogin,
          repo: repository.name,
          head: branch,
          base: repository.defaultBranch,
          title: `Apply upstream update ${result.upstreamSha.slice(0, 12)}`,
          body: `Automated update from ${repository.upstreamFullName}@${result.upstreamSha}.`,
        })
        const run = await recordUpkeepRun(db).record({
          repositoryId,
          branch,
          outcome: "pr_opened",
          upstreamSha: result.upstreamSha,
          forkSha: result.mergeSha,
          behindBy: result.behindBy,
          aheadBy: result.aheadBy,
          mergeType: "merge",
          pullRequestNumber: pr.number,
          pullRequestUrl: pr.url,
        })
        await enqueueUpkeepPrFinalizer(db, run.id)
      }
      return
    }

    const position = await compareWithUpstream(client, inspectionCredential, {
      owner: repository.ownerLogin,
      repo: repository.name,
      branch: repository.defaultBranch,
      upstreamFullName: repository.upstreamFullName,
      upstreamBranch: repository.upstreamDefaultBranch ?? repository.defaultBranch,
    })

    const decision = decideUpkeepAction(position)

    if (decision.action === "skip") {
      await recordUpkeepRun(db).record({
        repositoryId,
        branch: repository.defaultBranch,
        outcome: "up_to_date",
        upstreamSha: position.upstreamSha,
        forkSha: position.forkSha,
        behindBy: position.behindBy,
        aheadBy: position.aheadBy,
        mergeType: "none",
      })
      return
    }

    const pending = await db
      .selectFrom("upstreamSyncRun")
      .select("id")
      .where("repositoryId", "=", repositoryId)
      .where("upstreamSha", "=", position.upstreamSha)
      .where("outcome", "=", "pr_opened")
      .orderBy("createdAt", "desc")
      .executeTakeFirst()
    if (pending !== undefined) {
      await enqueueUpkeepPrFinalizer(db, pending.id)
      return
    }

    try {
      const writeCredential = await credentialFor(installationId, {
        purpose: "upkeep-sync",
        repositoryId: githubRepoId,
      })
      const branch = upkeepBranchName(position.upstreamSha)
      await ensureBranch(client, writeCredential, {
        owner: repository.ownerLogin,
        repo: repository.name,
        branch,
        sha: position.forkSha,
      })
      const sync = await syncWithUpstream(
        client,
        writeCredential,
        repository.ownerLogin,
        repository.name,
        branch,
      )
      const [upstreamOwner, upstreamRepo] = repository.upstreamFullName.split("/")
      if (upstreamOwner === undefined || upstreamRepo === undefined) {
        throw new Error(`invalid upstream repository ${repository.upstreamFullName}`)
      }
      const observedUpstreamSha = await getBranchHeadSha(
        client,
        inspectionCredential,
        upstreamOwner,
        upstreamRepo,
        repository.upstreamDefaultBranch ?? repository.defaultBranch,
      )
      if (observedUpstreamSha !== position.upstreamSha) {
        await deleteBranch(client, writeCredential, {
          owner: repository.ownerLogin,
          repo: repository.name,
          branch,
        })
        throw new Error("upstream changed during reconciliation; the next run will compare again")
      }
      const proposedSha = await getBranchHeadSha(
        client,
        writeCredential,
        repository.ownerLogin,
        repository.name,
        branch,
      )
      const pr = await ensurePullRequest(client, writeCredential, {
        owner: repository.ownerLogin,
        repo: repository.name,
        head: branch,
        base: repository.defaultBranch,
        title: `Apply upstream update ${position.upstreamSha.slice(0, 12)}`,
        body: `Automated update from ${repository.upstreamFullName}@${position.upstreamSha}.`,
      })
      const run = await recordUpkeepRun(db).record({
        repositoryId,
        branch,
        outcome: "pr_opened",
        upstreamSha: position.upstreamSha,
        forkSha: proposedSha,
        behindBy: position.behindBy,
        aheadBy: position.aheadBy,
        mergeType: sync.mergeType === "fast-forward" ? "fast_forward" : "merge",
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.url,
      })
      await enqueueUpkeepPrFinalizer(db, run.id)
    } catch (error) {
      // 409 is GitHub declining to merge, which is a conflict, not a fault. Anything else is.
      const conflicted = error instanceof GitHubApiError && error.status === 409

      const run = await recordUpkeepRun(db).record({
        repositoryId,
        branch: repository.defaultBranch,
        outcome: conflicted ? "conflict" : "failed",
        upstreamSha: position.upstreamSha,
        forkSha: position.forkSha,
        behindBy: position.behindBy,
        aheadBy: position.aheadBy,
        mergeType: null,
      })

      if (!conflicted) throw error

      const branch = upkeepBranchName(position.upstreamSha)
      const writeCredential = await credentialFor(installationId, {
        purpose: "upkeep-sync",
        repositoryId: githubRepoId,
      })
      await deleteBranch(client, writeCredential, {
        owner: repository.ownerLogin,
        repo: repository.name,
        branch,
      })

      await recordUpkeepRun(db).suggestToProjects(
        run.id,
        await subscribedProjects(db, repositoryId),
        `${repository.upstreamFullName} is ${position.behindBy} commit(s) ahead and cannot be merged automatically.`,
      )
      await startConflictResolution(db, {
        runId: run.id,
        repositoryId,
        upstreamSha: position.upstreamSha,
        forkSha: position.forkSha,
        requestedProjectId,
        requestedByUserId,
      })
    }
  }
}
