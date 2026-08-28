import { fetchUpkeepStatus, recordUpkeepRun } from "@lib/dao"
import {
  compareWithUpstream,
  createGitHubClient,
  createInstallationTokenStore,
  envAppJwtSigner,
  GitHubApiError,
  repositoryTagState,
  type GitHubClient,
  type GitHubCredential,
  syncWithUpstream,
} from "@lib/github"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { decideUpkeepAction } from "./upkeep-decision"
import type { JobHandler } from "./worker"
import type { UpkeepTrigger } from "@lib/dao"
import {
  reconcileTemplateUpstream,
  type TemplateUpstreamInput,
  type TemplateUpstreamResult,
} from "./template-upstream"

type UpkeepPayload = { repositoryId: string; trigger?: UpkeepTrigger }

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
  credentialFor: (installationId: number) => Promise<GitHubCredential>
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
    defaults = { client, credentialFor: (id) => tokens.get(id) }
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
 *  - **A fast-forward.** Done server-side through GitHub's `merge-upstream`, so there is no
 *    runner, no checkout and nothing to charge for. This is the common case for a fork whose owner
 *    only changed configuration, and paying a model to perform a fast-forward would be absurd.
 *  - **A real reconciliation.** Attempted as a server-side merge first, since GitHub resolves
 *    everything that is not a genuine textual conflict for free. What comes back as a conflict is
 *    raised to each subscribed project as a suggestion for a person to act on.
 *
 * **What this deliberately does not do yet:** drive an agent to resolve a genuine conflict. That
 * path needs the merge resolved in a workspace and then pushed, and the push cannot come from the
 * runner — the agent sandbox is never given a push credential, so the trusted job would have to
 * push on its behalf. Until that exists, a conflicted fork produces a suggestion rather than a
 * pull request, which is visible and honest rather than silent.
 */
export function upkeepRepository(deps?: UpkeepDeps): JobHandler {
  return async (job, context) => {
    const { db } = context
    const { repositoryId, trigger = "interval" } = job.payload as UpkeepPayload

    const repository = await db
      .selectFrom("repository")
      .select([
        "id",
        "ownerLogin",
        "name",
        "defaultBranch",
        "provenance",
        "upstreamFullName",
        "upstreamDefaultBranch",
        "upstreamTagFingerprint",
        "githubInstallationId",
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
    const credential = await credentialFor(Number(installation.installationId))

    let observedTagFingerprint: string | undefined
    if (trigger === "tag") {
      const tags = await repositoryTagState(client, credential, repository.upstreamFullName)

      if (tags.fingerprint === repository.upstreamTagFingerprint) {
        await db
          .updateTable("repository")
          .set({ upstreamTagCheckedAt: new Date(), updatedAt: new Date() })
          .where("id", "=", repositoryId)
          .execute()
        return
      }

      // Establishing an empty baseline is not an update. Once a baseline exists, however, removing
      // the last tag is still a tag-set change and follows the same safe sync path as an addition
      // or moved tag.
      if (!tags.hasTags && repository.upstreamTagFingerprint === null) {
        await db
          .updateTable("repository")
          .set({
            upstreamTagCheckedAt: new Date(),
            upstreamTagFingerprint: tags.fingerprint,
            updatedAt: new Date(),
          })
          .where("id", "=", repositoryId)
          .execute()
        return
      }
      observedTagFingerprint = tags.fingerprint
    }

    if (repository.provenance === "template") {
      const base = await db
        .selectFrom("upstreamSyncRun")
        .select("upstreamSha")
        .where("repositoryId", "=", repositoryId)
        .where("branch", "=", repository.defaultBranch)
        .where("outcome", "=", "up_to_date")
        .where("upstreamSha", "is not", null)
        .orderBy("id", "desc")
        .executeTakeFirst()

      let result: TemplateUpstreamResult
      try {
        result = await (deps?.reconcileTemplate ?? reconcileTemplateUpstream)({
          owner: repository.ownerLogin,
          repo: repository.name,
          branch: repository.defaultBranch,
          upstreamFullName: repository.upstreamFullName,
          upstreamBranch: repository.upstreamDefaultBranch ?? repository.defaultBranch,
          token: credential.token,
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
        if (observedTagFingerprint !== undefined) {
          await recordObservedTag(db, repositoryId, observedTagFingerprint)
        }
        await recordUpkeepRun(db).suggestToProjects(
          run.id,
          await subscribedProjects(db, repositoryId),
          `${repository.upstreamFullName} conflicts with local changes in: ${result.conflicts.join(", ")}.`,
        )
        return
      }

      await recordUpkeepRun(db).record({
        repositoryId,
        branch: repository.defaultBranch,
        outcome: "up_to_date",
        upstreamSha: result.upstreamSha,
        forkSha: result.outcome === "merged" ? result.mergeSha : result.targetSha,
        behindBy: result.behindBy,
        aheadBy: result.aheadBy,
        mergeType: result.outcome === "merged" ? "merge" : "none",
      })

      await db
        .updateTable("repository")
        .set({
          lastSyncedAt: new Date(),
          ...(observedTagFingerprint === undefined
            ? {}
            : {
                upstreamTagCheckedAt: new Date(),
                upstreamTagFingerprint: observedTagFingerprint,
              }),
          updatedAt: new Date(),
        })
        .where("id", "=", repositoryId)
        .execute()
      return
    }

    const position = await compareWithUpstream(client, credential, {
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
      if (observedTagFingerprint !== undefined) {
        await recordObservedTag(db, repositoryId, observedTagFingerprint)
      }
      return
    }

    try {
      const sync = await syncWithUpstream(
        client,
        credential,
        repository.ownerLogin,
        repository.name,
        repository.defaultBranch,
      )

      await recordUpkeepRun(db).record({
        repositoryId,
        branch: repository.defaultBranch,
        outcome: "up_to_date",
        upstreamSha: position.upstreamSha,
        forkSha: position.forkSha,
        behindBy: position.behindBy,
        aheadBy: position.aheadBy,
        // GitHub says "fast-forward"; the column's vocabulary is "fast_forward".
        mergeType: sync.mergeType === "fast-forward" ? "fast_forward" : "merge",
      })

      await db
        .updateTable("repository")
        .set({
          lastSyncedAt: new Date(),
          ...(observedTagFingerprint === undefined
            ? {}
            : {
                upstreamTagCheckedAt: new Date(),
                upstreamTagFingerprint: observedTagFingerprint,
              }),
          updatedAt: new Date(),
        })
        .where("id", "=", repositoryId)
        .execute()
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

      if (observedTagFingerprint !== undefined) {
        await recordObservedTag(db, repositoryId, observedTagFingerprint)
      }

      await recordUpkeepRun(db).suggestToProjects(
        run.id,
        await subscribedProjects(db, repositoryId),
        `${repository.upstreamFullName} is ${position.behindBy} commit(s) ahead and cannot be merged automatically.`,
      )
    }
  }
}

async function recordObservedTag(
  db: Kysely<DB>,
  repositoryId: string,
  fingerprint: string,
): Promise<void> {
  const now = new Date()
  await db
    .updateTable("repository")
    .set({
      upstreamTagCheckedAt: now,
      upstreamTagFingerprint: fingerprint,
      updatedAt: now,
    })
    .where("id", "=", repositoryId)
    .execute()
}
