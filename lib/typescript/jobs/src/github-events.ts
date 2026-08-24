import { crudDeployment } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
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

  await db
    .insertInto("githubInstallation")
    .values({
      id: v7(),
      organizationId,
      installationId: String(installation.id),
      accountLogin: login,
      accountType: installation.account.type ?? "User",
      repositorySelection: installation.repository_selection ?? "selected",
      permissions: (installation.permissions ?? {}) as never,
    })
    /*
      Keyed on the installation, because GitHub reuses the id across events — `created`,
      `new_permissions_accepted`, `suspend`, `unsuspend` all carry the same one. Inserting on each
      would give one installation several rows and whichever was read first would win.
    */
    .onConflict((oc) =>
      oc.column("installationId").doUpdateSet({
        organizationId,
        accountLogin: login,
        repositorySelection: installation.repository_selection ?? "selected",
        permissions: (installation.permissions ?? {}) as never,
        suspendedAt: action === "suspend" ? new Date() : null,
        updatedAt: new Date(),
      }),
    )
    .execute()

  console.info(`[jobs] installation ${installation.id} on ${login} linked to ${organizationId}`)
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
 * keyed on `(project, pr_number)` by `deployment_preview_pr_key`, so re-pushing to a PR updates the
 * same preview rather than accumulating one per commit.
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
        await crudDeployment(db).update(preview.id, { status: "torn_down" })
      }
      if (previews.length > 0) {
        console.info(`[jobs] PR #${pr.number} closed: tore down ${previews.length} preview(s)`)
      }
      continue
    }

    if (action !== "opened" && action !== "synchronize" && action !== "reopened") continue
    if (pr.head?.sha === undefined) continue

    const deployment = await crudDeployment(db).create({
      id: v7(),
      projectId: project.id,
      kind: "preview",
      prNumber: pr.number,
      gitSha: pr.head.sha,
      gitRef: pr.head.ref === undefined ? null : `refs/heads/${pr.head.ref}`,
      status: "queued",
    })

    await enqueue(db, {
      kind: PUBLISH_KINDS.release,
      organizationId: project.organizationId,
      payload: { deploymentId: deployment.id },
      idempotencyKey: `${PUBLISH_KINDS.release}:${deployment.id}`,
    })

    console.info(`[jobs] PR #${pr.number} ${action}: deploying preview for project ${project.id}`)
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

/** The organization owning repositories under a GitHub account login. */
async function organizationForLogin(db: Kysely<DB>, login: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("repository")
    .select(["organizationId"])
    .where("ownerLogin", "=", login)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "asc")
    .executeTakeFirst()

  return row?.organizationId
}

export const GITHUB_EVENT_HANDLERS: Record<string, JobHandler> = {
  [GITHUB_EVENT_KINDS.installationSync]: installationSync,
  [GITHUB_EVENT_KINDS.push]: push,
  [GITHUB_EVENT_KINDS.pullRequest]: pullRequest,
  [GITHUB_EVENT_KINDS.ping]: acknowledge,
  [GITHUB_EVENT_KINDS.unhandled]: acknowledge,
}
