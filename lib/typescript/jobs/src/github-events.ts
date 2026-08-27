import { crudDeployment } from "@lib/dao"
import {
  appJwt,
  createGitHubClient,
  envAppJwtSigner,
  linkInstallation,
  MissingGitHubAppConfigError,
} from "@lib/github"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { v7 } from "uuid"
import { type Committer, recordCommitters } from "@lib/billing"
import { PUBLISH_KINDS } from "./publish"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

/**
 * What happens after a GitHub webhook is verified.
 *
 * `POST /v1/webhooks/github` checks the signature, acknowledges inside GitHub's ten-second window,
 * and queues the delivery under one of five kinds. **None of those kinds had a handler.** Every
 * webhook this platform has ever received was verified, queued, and left sitting there — so:
 *
 * - `installation` never wrote a `github_installation` row, which is why the GitHub App is
 *   invisible to the platform even when it is installed, and why forking falls back to a customer's
 *   personal OAuth token;
 * - `push` never deployed anything, so a merge to the production branch did nothing;
 * - `pull_request` never created a preview, which is TASK 36 in its entirety.
 *
 * All three read as wired: the receiver dispatches on event type, the job kinds are named, the rows
 * accumulate in `background_job`. Nothing ran them.
 */

export const GITHUB_EVENT_KINDS = {
  installationSync: "github.installation.sync",
  installationDiscover: "github.installation.discover",
  push: "github.push",
  pullRequest: "github.pull_request",
  ping: "github.ping",
  unhandled: "github.unhandled",
} as const

/** The shape the receiver queues. */
type Delivery = { event?: string; delivery?: string; body?: Record<string, unknown> }

/**
 * Record an installation, so the App becomes usable.
 *
 * The organization is matched by the GitHub account the App was installed on — a login this
 * platform already stores on `repository.owner_login`, and the only link available without a setup
 * redirect. An installation on an account no organization here owns is *kept out* of the table
 * rather than guessed at: attaching it to the wrong organization would hand one customer a token
 * for another customer's repositories.
 */
const installationSync: JobHandler = async (job, { db }) => {
  const { body } = job.payload as Delivery
  const installation = body?.installation as
    | {
        id?: number
        account?: { login?: string; type?: string }
        repository_selection?: string
        permissions?: Record<string, string>
      }
    | undefined

  if (installation?.id === undefined || installation.account?.login === undefined) {
    console.warn("[jobs] installation event with no installation; ignoring")
    return
  }

  const login = installation.account.login
  const action = body?.action as string | undefined

  if (action === "deleted") {
    /*
      Removed, not soft-deleted.

      An installation that no longer exists cannot produce a token, and keeping the row would mean
      every later attempt fails at GitHub instead of falling back to the customer's own credential
      — which still works. Deleting is what makes the fallback reachable again.
    */
    const removed = await db
      .deleteFrom("githubInstallation")
      .where("installationId", "=", String(installation.id))
      .executeTakeFirst()
    console.info(
      `[jobs] installation ${installation.id} deleted (${Number(removed.numDeletedRows ?? 0)} row)`,
    )
    return
  }

  const organizationId = await organizationForLogin(db, login)
  if (organizationId === undefined) {
    // Not an error. Someone can install the App on an account before creating anything here, and a
    // later `installation_repositories` event or a re-install links it once there is something to
    // link it to.
    console.info(
      `[jobs] installation ${installation.id} on ${login}: no organization owns that account yet`,
    )
    return
  }

  await linkInstallation(db, organizationId, {
    id: installation.id,
    login,
    accountType: installation.account.type ?? "User",
    repositorySelection: installation.repository_selection ?? "selected",
    permissions: installation.permissions ?? {},
    suspended: action === "suspend",
  })
}

/** What `GET /app/installations` returns, narrowed to the fields stored. */
type AppInstallation = {
  id: number
  account?: { login?: string; type?: string } | null
  repository_selection?: string
  permissions?: Record<string, string>
  suspended_at?: string | null
}

/**
 * Links an installation that arrived before there was anything to link it to.
 *
 * `installationSync` drops an installation on an account no organization owns yet — correctly, since
 * guessing would hand one customer a token for another's repositories. Its comment promised that "a
 * later `installation_repositories` event or a re-install links it once there is something to link
 * it to", and that promise had no mechanism behind it: creating a project is not a GitHub event, so
 * no delivery ever arrives. Installing the App *before* creating the first project — the order the
 * onboarding copy actually suggests — left the App permanently invisible.
 *
 * Redelivering the original webhook does not fix it either. The receiver keys idempotency on
 * `X-GitHub-Delivery`, and a manual redelivery reuses that id, so the redelivery is dropped as a
 * duplicate of the delivery that ran too early. The 200 is honest; nothing runs.
 *
 * So the link is re-derived from GitHub rather than waited for. `GET /app/installations` is the
 * authority on where the App is installed, and it is asked at the moment a `repository` row makes
 * the answer meaningful. No guessing: the login must match one this organization already owns.
 */
const installationDiscover: JobHandler = async (job, { db }) => {
  const payload = job.payload as { login?: string; organizationId?: string }
  const login = payload.login
  const organizationId = payload.organizationId
  if (login === undefined || organizationId === undefined) {
    console.warn("[jobs] installation discovery with no login; ignoring")
    return
  }

  /*
    The row must confirm the claim, not the payload.

    The job's `organizationId` comes from whoever enqueued it. Re-reading `repository` means a
    forged or stale payload can only re-link an account this organization genuinely owns.
  */
  const owner = await organizationForLogin(db, login)
  if (owner !== organizationId) {
    console.warn(`[jobs] installation discovery for ${login}: organization no longer owns it`)
    return
  }

  let signJwt: () => string
  try {
    signJwt = envAppJwtSigner()
  } catch (error) {
    if (error instanceof MissingGitHubAppConfigError) {
      // Development and any deployment without the App configured. Forking still works on the
      // customer's own OAuth token, so this is a missing enhancement, not a failure.
      console.info(`[jobs] installation discovery for ${login}: GitHub App is not configured`)
      return
    }
    throw error
  }

  const response = await createGitHubClient().request<AppInstallation[]>({
    method: "GET",
    path: "/app/installations?per_page=100",
    credential: appJwt(signJwt()),
  })

  // GitHub logins are case-insensitive, and `repository.owner_login` preserves whatever case the
  // caller typed. Matching case-sensitively would miss an installation that is plainly there.
  const target = login.toLowerCase()
  const match = response.data.find((entry) => entry.account?.login?.toLowerCase() === target)
  if (match === undefined) {
    console.info(`[jobs] installation discovery for ${login}: the App is not installed there`)
    return
  }

  await linkInstallation(db, organizationId, {
    id: match.id,
    login: match.account?.login ?? login,
    accountType: match.account?.type ?? "User",
    repositorySelection: match.repository_selection ?? "selected",
    permissions: match.permissions ?? {},
    suspended: match.suspended_at != null,
  })
}

/**
 * Deploy a push to a project's production branch.
 *
 * One deployment per project, because several projects may share a repository — TASK 21 — and a
 * push to that repository is a new revision of each of them.
 */
/**
 * Every distinct author in a push, recorded against the repository.
 *
 * GitHub sends both `author` and `committer` on each commit, and they differ on a rebase or a
 * co-authored merge — the person who wrote it and the person who applied it. Both are counted:
 * "committing to the repository" is what the requirement says, and a reviewer who lands somebody
 * else's work is using the platform too.
 */
async function recordPush(
  db: Kysely<DB>,
  githubRepoId: number,
  body: Record<string, unknown> | undefined,
): Promise<void> {
  const commits = (body?.commits as CommitPayload[] | undefined) ?? []
  if (commits.length === 0) return

  const repositoryRow = await db
    .selectFrom("repository")
    .select("id")
    .where("githubRepoId", "=", String(githubRepoId))
    .where("deletedAt", "is", null)
    .executeTakeFirst()

  if (repositoryRow === undefined) return

  const people: Committer[] = []
  for (const commit of commits) {
    for (const person of [commit.author, commit.committer]) {
      if (person === undefined) continue
      people.push({ login: person.username ?? null, email: person.email ?? null })
    }
  }

  await recordCommitters(db, repositoryRow.id, people)
}

type CommitPayload = {
  author?: { username?: string; email?: string }
  committer?: { username?: string; email?: string }
}

const push: JobHandler = async (job, { db }) => {
  const { body } = job.payload as Delivery
  const repository = body?.repository as { id?: number } | undefined
  const ref = body?.ref as string | undefined
  const after = body?.after as string | undefined

  if (repository?.id === undefined || ref === undefined || after === undefined) return

  // A branch delete pushes all zeros. Deploying that would build nothing at a commit that is gone.
  if (/^0+$/.test(after)) return

  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined
  if (branch === undefined) return

  /*
    Who committed, before anything about deploying.

    §2's team fee is decided from this and nothing else — the platform receives every push and used
    to throw the author away, so a fee that depends on "more than 2 users committing" had no
    evidence to depend on. Recorded for every branch, not only the production one: a team of three
    working on feature branches is still a team of three.

    Failing here must not stop a deploy. A customer's push landing is more important than the
    platform's own bookkeeping, and the next push records them again.
  */
  try {
    await recordPush(db, repository.id, body)
  } catch (cause) {
    console.error(`[jobs] could not record committers: ${String(cause)}`)
  }

  const projects = await db
    .selectFrom("project")
    .innerJoin("repository", "repository.id", "project.repositoryId")
    .select([
      "project.id as id",
      "project.organizationId as organizationId",
      "project.productionBranch as productionBranch",
    ])
    .where("repository.githubRepoId", "=", String(repository.id))
    .where("project.deletedAt", "is", null)
    .execute()

  for (const project of projects) {
    if (project.productionBranch !== branch) continue

    const deployment = await crudDeployment(db).create({
      id: v7(),
      projectId: project.id,
      kind: "production",
      gitSha: after,
      gitRef: ref,
      status: "queued",
    })

    await enqueue(db, {
      kind: PUBLISH_KINDS.release,
      organizationId: project.organizationId,
      payload: { deploymentId: deployment.id },
      idempotencyKey: `${PUBLISH_KINDS.release}:${deployment.id}`,
    })

    console.info(`[jobs] push ${after.slice(0, 7)} on ${branch}: deploying project ${project.id}`)
  }
}

/**
 * Preview deployments — TASK 36.
 *
 * `opened` and `synchronize` deploy the head commit; `closed` tears the preview down. A preview is
 * keyed by PR at the provider alias and hostname. Deployment rows remain immutable history; the
 * publisher retires the previous ready row only after its replacement is serving.
 */
const pullRequest: JobHandler = async (job, { db }) => {
  const { body } = job.payload as Delivery
  const action = body?.action as string | undefined
  const repository = body?.repository as { id?: number } | undefined
  const pr = body?.pull_request as
    | { number?: number; head?: { sha?: string; ref?: string } }
    | undefined

  if (repository?.id === undefined || pr?.number === undefined) return

  const projects = await db
    .selectFrom("project")
    .innerJoin("repository", "repository.id", "project.repositoryId")
    .select(["project.id as id", "project.organizationId as organizationId"])
    .where("repository.githubRepoId", "=", String(repository.id))
    .where("project.deletedAt", "is", null)
    .execute()

  for (const project of projects) {
    if (action === "closed") {
      /*
        Marked, not deleted.

        `usage_event` references a deployment for as long as its billing history exists, so a
        preview cannot take the evidence behind its own charges with it. `torn_down` is what the
        deploy handler checks before doing anything, so this stops the revision as well.
      */
      const previews = await db
        .selectFrom("deployment")
        .select(["id"])
        .where("projectId", "=", project.id)
        .where("kind", "=", "preview")
        .where("prNumber", "=", pr.number)
        .where("status", "!=", "torn_down")
        .execute()

      for (const preview of previews) {
        await enqueue(db, {
          kind: PUBLISH_KINDS.tearDownPreview,
          organizationId: project.organizationId,
          payload: { deploymentId: preview.id },
          idempotencyKey: `${PUBLISH_KINDS.tearDownPreview}:${preview.id}`,
        })
      }
      if (previews.length > 0) {
        console.info(
          `[jobs] PR #${pr.number} closed: queued ${previews.length} preview teardown(s)`,
        )
      }
      continue
    }

    if (action !== "opened" && action !== "synchronize" && action !== "reopened") continue
    if (pr.head?.sha === undefined) continue
    // The repository's deploy action builds and uploads the artifact, then creates the release.
    // A webhook has only a SHA; inventing a deployment here guarantees the publisher rejects it for
    // having no artifact and leaves a duplicate error row beside the action's real preview.
    console.info(
      `[jobs] PR #${pr.number} ${action}: waiting for the repository deploy action for project ${project.id}`,
    )
  }
}

/**
 * `ping`, and anything not subscribed to.
 *
 * Handlers rather than nothing, so the queue drains. A kind with no handler is a row that fails,
 * retries to its limit and sits in `background_job` forever — which is how a queue full of
 * unprocessable work becomes indistinguishable from a queue that is behind.
 */
const acknowledge: JobHandler = async (job) => {
  const { event, delivery } = job.payload as Delivery
  console.info(`[jobs] github ${event ?? "?"} delivery ${delivery ?? "?"}: acknowledged`)
  await Promise.resolve()
}

/**
 * The organization owning repositories under a GitHub account login.
 *
 * Compared case-insensitively, because the two sides of the comparison come from different places:
 * `repository.owner_login` keeps whatever case the customer typed into the new-project form, and
 * GitHub answers with the account's canonical case. An exact match would report the App as not
 * installed on an account it is plainly installed on, over a difference GitHub does not consider a
 * difference at all.
 */
async function organizationForLogin(db: Kysely<DB>, login: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("repository")
    .select(["organizationId"])
    .where(sql<string>`lower(owner_login)`, "=", login.toLowerCase())
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "asc")
    .executeTakeFirst()

  return row?.organizationId
}

export const GITHUB_EVENT_HANDLERS: Record<string, JobHandler> = {
  [GITHUB_EVENT_KINDS.installationSync]: installationSync,
  [GITHUB_EVENT_KINDS.installationDiscover]: installationDiscover,
  [GITHUB_EVENT_KINDS.push]: push,
  [GITHUB_EVENT_KINDS.pullRequest]: pullRequest,
  [GITHUB_EVENT_KINDS.ping]: acknowledge,
  [GITHUB_EVENT_KINDS.unhandled]: acknowledge,
}
