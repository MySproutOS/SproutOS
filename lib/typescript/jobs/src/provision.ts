import {
  createGitHubClient,
  createOrganizationRepository,
  createPersonalRepository,
  forkRepository,
  generateFromTemplate,
  getBranchHeadSha,
  getRepository,
  type GitHubCredential,
  type GitHubRepository,
  userGitHubCredential,
} from "@lib/github"
import { crudDeployment } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { ProjectJobStep } from "@lib/dao/projectJob/crud"
import { DEPLOY_KINDS } from "./deploy"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

/**
 * What actually creates a customer's repository.
 *
 * **This did not exist.** `POST /v1/orgs/:orgSlug/projects` wrote a `project` row, a `repository`
 * row with no `github_repo_id`, and a `project_job` whose four steps were all `pending` — and
 * nothing in the repository ever claimed one. `crudProjectJob` had `create`, `enqueueOnce` and
 * `update`; `fetchProjectJob` had three readers; every one of the writers was the API. The
 * `PROJECT_JOB_STEPS` table describes "Forking the upstream repository", "Linking the GitHub App
 * installation", "Detecting build settings" and "Running the first deploy", and no code moved a
 * step out of `pending`.
 *
 * So forking an app returned 201, showed a project, and produced nothing on GitHub. Forever, with
 * a progress list that looked like a job about to start.
 *
 * `lib/typescript/github` already had every call this needs — `forkRepository`,
 * `createPersonalRepository`, `createOrganizationRepository`, `generateFromTemplate` — written,
 * tested, and called by nothing.
 */
export const PROVISION_KIND = "project.provision"

/** What the background job carries. The `project_job` row holds everything else. */
export type ProvisionPayload = {
  projectJobId: string
  /** Whose OAuth token to act as, when there is no installation to act as instead. */
  userId: string
}

export class NoUsableCredentialError extends Error {
  override readonly name = "NoUsableCredentialError"

  constructor() {
    super(
      "No GitHub credential can perform this. The organization has no GitHub App installation, " +
        "and the user's OAuth token was not granted the `repo` scope. Re-authenticate through " +
        "/login/github?scopes=repository to grant it.",
    )
  }
}

/** Mark one step, and recompute `progress` from the step list rather than tracking it separately. */
function withStep(
  steps: ProjectJobStep[],
  key: string,
  state: ProjectJobStep["state"],
): { steps: ProjectJobStep[]; progress: number } {
  const next = steps.map((step) => (step.key === key ? { ...step, state } : step))
  const done = next.filter((step) => step.state === "succeeded" || step.state === "skipped").length
  return { steps: next, progress: Math.round((done / Math.max(next.length, 1)) * 100) }
}

/**
 * Runs one `project_job` to completion, or records why it could not.
 *
 * Claimed with a conditional update rather than a lock: `state = 'queued'` in the WHERE clause
 * means exactly one worker transitions it, and a second worker's update affects zero rows and
 * returns. The background-job runner already guarantees one claimant per *background* job, but the
 * `project_job` is a separate row and a retry after a crash would otherwise fork twice.
 */
/**
 * The GitHub side, injectable.
 *
 * Production passes nothing and gets the real client plus the signed-in user's token. A test passes
 * both, which is the only way to exercise this function at all: everything it does that matters
 * happens *after* the GitHub call, and a version that could only be run against github.com could
 * only be checked by forking a repository for real.
 *
 * The same shape `tearDownProject` uses for its Kubernetes client, for the same reason.
 */
export type ProvisionGitHub = {
  client: ReturnType<typeof createGitHubClient>
  credential: GitHubCredential
}

export async function runProvision(
  db: Kysely<DB>,
  payload: ProvisionPayload,
  github?: ProvisionGitHub,
): Promise<void> {
  const claimed = await db
    .updateTable("projectJob")
    .set({ state: "running", startedAt: new Date(), updatedAt: new Date() })
    .where("id", "=", payload.projectJobId)
    .where("state", "=", "queued")
    .returningAll()
    .executeTakeFirst()

  // Already running or finished. Not an error: the job runner retries, and a retry of a job whose
  // GitHub call already succeeded must not run it again.
  if (claimed === undefined) return

  // Bound to a const so the closure below narrows. `claimed` is already non-undefined here, but
  // TypeScript re-widens a `let`-scoped narrowing inside a nested function.
  const job = claimed
  let steps = job.steps as ProjectJobStep[]

  async function mark(key: string, state: ProjectJobStep["state"]): Promise<void> {
    const next = withStep(steps, key, state)
    steps = next.steps
    await db
      .updateTable("projectJob")
      .set({ steps: JSON.stringify(steps), progress: next.progress, updatedAt: new Date() })
      .where("id", "=", job.id)
      .execute()
  }

  try {
    if (job.repositoryId === null) throw new Error("project_job has no repository to provision")

    const repository = await db
      .selectFrom("repository")
      .selectAll()
      .where("id", "=", job.repositoryId)
      .executeTakeFirstOrThrow()

    const createStep = job.kind === "fork" ? "fork_repository" : "create_repository"
    await mark(createStep, "running")

    const credential = github?.credential ?? (await userGitHubCredential(db, payload.userId))
    if (credential === undefined) throw new NoUsableCredentialError()

    const client = github?.client ?? createGitHubClient()
    const created = await createOnGitHub(client, credential, job.kind, repository)

    await db
      .updateTable("repository")
      .set({
        githubRepoId: created.id,
        defaultBranch: created.defaultBranch,
        private: created.private,
        updatedAt: new Date(),
      })
      .where("id", "=", repository.id)
      .execute()

    await mark(createStep, "succeeded")

    /*
      The first deploy.

      This step was `skipped`, with a comment saying the build pipeline "exists elsewhere in the
      repository and is not wired to this job yet". That was true and it was the whole product: a
      customer clicked "Fork this app", got a repository on GitHub, and got a project marked `ready`
      that had never been built and was serving nothing. `deployment` held one row, from a seed.

      Wiring it is two calls, because everything downstream already works — `DEPLOY_KINDS.revision`
      finds no image, enqueues the build, and the build enqueues the deploy back. What was missing
      was only the first push.

      The sha is read rather than assumed. A deployment is of a commit: it is what the build checks
      out, what the image is tagged with, and what a rollback names, and `deployment.git_sha` is not
      nullable. A fork is asynchronous on GitHub's side, so this can 404 for a moment after the
      repository itself is readable; that failure belongs to the step, which is why the deploy is
      marked `running` before the lookup rather than after it.
    */
    if (job.projectId !== null) {
      await mark("first_deploy", "running")

      const branch = created.defaultBranch
      const sha = await getBranchHeadSha(
        client,
        credential,
        created.ownerLogin,
        created.name,
        branch,
      )

      const deployment = await crudDeployment(db).create({
        id: v7(),
        projectId: job.projectId,
        kind: "production",
        gitSha: sha,
        gitRef: branch,
        prNumber: null,
        status: "queued",
      })

      await enqueue(db, {
        kind: DEPLOY_KINDS.revision,
        organizationId: job.organizationId,
        payload: { deploymentId: deployment.id },
        idempotencyKey: `${DEPLOY_KINDS.revision}:${deployment.id}`,
      })

      await mark("first_deploy", "succeeded")
    }

    /*
      The two that remain are honestly `skipped`, not `succeeded`.

      Linking an installation needs a GitHub App installation on the account that owns the fork, and
      the fork's owner is whoever signed in — not necessarily anywhere the App is installed.
      Detecting build settings is the TASK 38/39 analyzer, which is an LLM call that costs real
      money per fork; it is offered as its own action rather than run unasked. Marking either
      `succeeded` would be the lie this job used to tell wholesale — a progress bar reaching 100%
      for work nobody did.
    */
    for (const step of steps) {
      if (step.state === "pending") await mark(step.key, "skipped")
    }

    await db
      .updateTable("projectJob")
      .set({ state: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", job.id)
      .execute()

    if (job.projectId !== null) {
      await db
        .updateTable("project")
        .set({ state: "ready", updatedAt: new Date() })
        .where("id", "=", job.projectId)
        .execute()
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const running = steps.find((step) => step.state === "running")
    if (running !== undefined) await mark(running.key, "failed")

    await db
      .updateTable("projectJob")
      .set({
        state: "failed",
        errorCode: cause instanceof Error ? cause.name : "Error",
        // Recorded on the row, because this is the only place a customer can see it. A provisioning
        // failure that lives in a worker's stdout is a project stuck in `creating` with no reason.
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", job.id)
      .execute()

    if (job.projectId !== null) {
      await db
        .updateTable("project")
        .set({ state: "failed", updatedAt: new Date() })
        .where("id", "=", job.projectId)
        .execute()
    }

    throw cause
  }
}

/**
 * The one GitHub call that differs per plan.
 *
 * `provenance` decides, not `kind`: a `provision` job whose repository records `template` has to
 * generate rather than create, and the two produce different histories — a template is one squashed
 * commit with no upstream, a fork tracks one. `repository.provenance` is what upkeep later reads to
 * decide whether tracking upstream means anything.
 */
async function createOnGitHub(
  client: ReturnType<typeof createGitHubClient>,
  credential: GitHubCredential,
  kind: string,
  repository: Selectable<DB["repository"]>,
): Promise<GitHubRepository> {
  if (kind === "fork") {
    if (repository.upstreamFullName === null) throw new Error("fork job has no upstream repository")
    const [owner, repo] = repository.upstreamFullName.split("/")
    if (owner === undefined || repo === undefined) {
      throw new Error(`upstream "${repository.upstreamFullName}" is not owner/repo`)
    }

    const forked = await forkRepository(client, credential, { owner, repo, name: repository.name })

    /*
      GitHub answers 202 and finishes asynchronously, so the repository in that response may not be
      clonable yet — and, more awkwardly, a fork of a repository the user already forked returns the
      *existing* fork. Re-reading it is how the row gets the id and default branch that are actually
      true, rather than the ones the 202 guessed.
    */
    return await getRepository(client, credential, forked.ownerLogin, forked.name)
  }

  if (repository.provenance === "template" && repository.upstreamFullName !== null) {
    const [templateOwner, templateRepo] = repository.upstreamFullName.split("/")
    if (templateOwner === undefined || templateRepo === undefined) {
      throw new Error(`template "${repository.upstreamFullName}" is not owner/repo`)
    }
    return await generateFromTemplate(client, credential, {
      templateOwner,
      templateRepo,
      name: repository.name,
      owner: repository.ownerLogin,
      private: repository.private,
    })
  }

  /*
    A personal account and an organization are different endpoints, and only one of them takes an
    installation token — `POST /user/repos` is `enabledForGitHubApps: false` (ADR 0005). Told apart
    by asking GitHub what the owner is rather than by guessing from the login, because a login that
    looks personal may be an organization and the failure is a 404 that reads like a typo.
  */
  const owner = await client.request<{ type?: string }>({
    method: "GET",
    path: `/users/${encodeURIComponent(repository.ownerLogin)}`,
    credential,
  })

  const input = { name: repository.name, private: repository.private, autoInit: true }

  return owner.data.type === "Organization"
    ? await createOrganizationRepository(client, credential, repository.ownerLogin, input)
    : await createPersonalRepository(client, { kind: "user", token: tokenOf(credential) }, input)
}

/** `createPersonalRepository` refuses anything but a user token, and says why. This narrows it. */
function tokenOf(credential: GitHubCredential): string {
  if (credential.kind !== "user") throw new NoUsableCredentialError()
  return credential.token
}

export const provisionProjectJob: JobHandler = async (job, { db }) => {
  const payload = job.payload as ProvisionPayload
  await runProvision(db, payload)
}
