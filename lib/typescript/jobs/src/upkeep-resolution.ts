import { createGitHubClient, createInstallationTokenStore, envAppJwtSigner } from "@lib/github"
import { crudAgentSession, crudProjectJob, recordUpkeepRun } from "@lib/dao"
import type { GitHubCredential } from "@lib/github"
import type { JobHandler } from "./worker"
import { resolveUpstreamConflict, type UpstreamConflictResolution } from "./upstream-conflict"

export const UPKEEP_RESOLUTION_KIND = "upkeep.resolve_conflict"
const STALE_AFTER_MS = 4 * 60 * 1000
const HEARTBEAT_MS = 60_000

export type UpkeepResolutionPayload = {
  projectJobId: string
}

type ResolutionDetails = {
  upstreamSyncRunId: string
  expectedUpstreamSha: string
  expectedTargetSha: string
  agentSessionId: string
  userId: string
}

export type UpkeepResolutionDeps = {
  credentialFor: (installationId: number) => Promise<GitHubCredential>
  resolve: typeof resolveUpstreamConflict
}

let defaults: UpkeepResolutionDeps | null = null

function defaultDeps(): UpkeepResolutionDeps {
  if (defaults === null) {
    const client = createGitHubClient()
    const tokens = createInstallationTokenStore({ client, signJwt: envAppJwtSigner() })
    defaults = {
      credentialFor: (installationId) => tokens.get(installationId),
      resolve: resolveUpstreamConflict,
    }
  }
  return defaults
}

/**
 * Resolve a user-accepted upstream conflict and open the guarded update PR.
 *
 * `project_job` is the durable, customer-visible state. A background retry reclaims it after a
 * bounded failure, while a completed or canceled row is a no-op. The agent receives a checkout but
 * never the GitHub write token; only `resolveUpstreamConflict`'s trusted finalizer may push.
 */
export function resolveUpkeepConflict(deps?: UpkeepResolutionDeps): JobHandler {
  return async (background, context) => {
    const payload = background.payload as UpkeepResolutionPayload
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS)
    const projectJob = await context.db
      .updateTable("projectJob")
      .set({
        state: "running",
        startedAt: new Date(),
        attempt: (eb) => eb("attempt", "+", 1),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where("id", "=", payload.projectJobId)
      .where("kind", "=", "sync_upstream")
      .where((eb) =>
        eb.or([
          eb("state", "=", "queued"),
          eb.and([eb("state", "=", "running"), eb("updatedAt", "<", staleBefore)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst()

    if (projectJob === undefined) return
    if (projectJob.projectId === null || projectJob.repositoryId === null) {
      throw new Error("sync_upstream project job has no project or repository")
    }
    const details = parseDetails(projectJob.details)
    const historicalConflict = await context.db
      .selectFrom("upstreamSyncRun")
      .select(["repositoryId", "outcome"])
      .where("id", "=", details.upstreamSyncRunId)
      .executeTakeFirst()
    if (
      historicalConflict?.repositoryId !== projectJob.repositoryId ||
      historicalConflict.outcome !== "conflict"
    ) {
      await failProjectJob(
        context.db,
        projectJob.id,
        "InvalidConflict",
        "The recorded conflict is not valid for this repository.",
      )
      return
    }

    const facts = await context.db
      .selectFrom("project")
      .innerJoin("organization", "organization.id", "project.organizationId")
      .innerJoin("repository", "repository.id", "project.repositoryId")
      .innerJoin("githubInstallation", "githubInstallation.id", "repository.githubInstallationId")
      .select([
        "project.organizationId",
        "organization.slug as organizationSlug",
        "project.id as projectId",
        "project.slug as projectSlug",
        "repository.ownerLogin",
        "repository.name",
        "repository.defaultBranch",
        "repository.provenance",
        "repository.upstreamFullName",
        "repository.upstreamDefaultBranch",
        "githubInstallation.installationId",
      ])
      .where("project.id", "=", projectJob.projectId)
      .where("repository.id", "=", projectJob.repositoryId)
      .executeTakeFirst()

    if (facts === undefined || facts.upstreamFullName === null) {
      await failProjectJob(
        context.db,
        projectJob.id,
        "InvalidConflict",
        "The conflict is no longer resolvable.",
      )
      return
    }

    const sessions = crudAgentSession(context.db)
    const touch = async () => {
      if (!(await context.keepAlive())) throw new Error("Lost ownership of upkeep resolution")
      const updated = await context.db
        .updateTable("projectJob")
        .set({ updatedAt: new Date() })
        .where("id", "=", projectJob.id)
        .where("state", "=", "running")
        .returning("id")
        .executeTakeFirst()
      if (updated === undefined) throw new UpkeepResolutionCanceledError()
    }
    const heartbeat = setInterval(() => void touch().catch(() => undefined), HEARTBEAT_MS)
    try {
      const credential = await (deps ?? defaultDeps()).credentialFor(Number(facts.installationId))
      const result = await (deps ?? defaultDeps()).resolve({
        agentSessionId: details.agentSessionId,
        branch: facts.defaultBranch,
        credential,
        db: context.db,
        expectedTargetSha: details.expectedTargetSha,
        expectedUpstreamSha: details.expectedUpstreamSha,
        organizationId: facts.organizationId,
        organizationSlug: facts.organizationSlug,
        owner: facts.ownerLogin,
        projectId: facts.projectId,
        projectSlug: facts.projectSlug,
        projectJobId: projectJob.id,
        provenance: facts.provenance,
        repo: facts.name,
        signal: context.signal,
        upstreamBranch: facts.upstreamDefaultBranch ?? facts.defaultBranch,
        upstreamFullName: facts.upstreamFullName,
        userId: details.userId,
        touch,
        mayPush: touch,
      })

      // Cancellation can race the model. Re-check before recording success; the resolver also
      // checks immediately before its trusted push, so a canceled job cannot publish late work.
      const state = await context.db
        .selectFrom("projectJob")
        .select("state")
        .where("id", "=", projectJob.id)
        .executeTakeFirst()
      if (state?.state === "canceled") return

      await recordUpkeepRun(context.db).record({
        repositoryId: projectJob.repositoryId,
        branch: facts.defaultBranch,
        outcome: "pr_opened",
        upstreamSha: details.expectedUpstreamSha,
        forkSha: details.expectedTargetSha,
        mergeType: "merge",
        pullRequestNumber: result.pullRequestNumber,
        pullRequestUrl: result.pullRequestUrl,
      })
      await crudProjectJob(context.db).update(projectJob.id, {
        state: "succeeded",
        progress: 100,
        steps: JSON.stringify([
          { key: "compare_upstream", label: "Comparing against upstream", state: "succeeded" },
          { key: "open_pull_request", label: "Opening a pull request", state: "succeeded" },
        ]),
        finishedAt: new Date(),
      })
      await sessions.setStatus(details.agentSessionId, "completed")
    } catch (error) {
      if (error instanceof UpkeepResolutionCanceledError) return
      const message = error instanceof Error ? error.message : String(error)
      const terminal = background.attempt >= background.maxAttempts
      await crudProjectJob(context.db).update(projectJob.id, {
        state: terminal ? "failed" : "queued",
        errorCode: error instanceof Error ? error.name : "Error",
        errorMessage: message.slice(0, 1000),
        ...(terminal ? { finishedAt: new Date() } : {}),
      })
      await sessions.setStatus(details.agentSessionId, terminal ? "failed" : "active")
      throw error
    } finally {
      clearInterval(heartbeat)
    }
  }
}

function parseDetails(value: unknown): ResolutionDetails {
  if (typeof value !== "object" || value === null) throw new Error("resolution job has no details")
  const details = value as Record<string, unknown>
  const required = [
    "upstreamSyncRunId",
    "expectedUpstreamSha",
    "expectedTargetSha",
    "agentSessionId",
    "userId",
  ] as const
  for (const key of required) {
    if (typeof details[key] !== "string" || details[key] === "") {
      throw new Error(`resolution job has invalid ${key}`)
    }
  }
  return details as ResolutionDetails
}

export class UpkeepResolutionCanceledError extends Error {
  override readonly name = "UpkeepResolutionCanceledError"
  constructor() {
    super("upkeep resolution was canceled")
  }
}

async function failProjectJob(
  db: Parameters<typeof crudProjectJob>[0],
  id: string,
  errorCode: string,
  errorMessage: string,
) {
  await crudProjectJob(db).update(id, {
    state: "failed",
    errorCode,
    errorMessage,
    finishedAt: new Date(),
  })
}

export type { UpstreamConflictResolution }
