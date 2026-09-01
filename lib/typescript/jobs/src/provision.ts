import {
  createGitHubClient,
  createOrganizationRepository,
  createPersonalRepository,
  forkRepository,
  GitHubApiError,
  getBranchHeadSha,
  getRepository,
  type GitHubCredential,
  type GitHubRepository,
  organizationGitHubCredential,
  userGitHubCredential,
} from "@lib/github"
import { crudStoreListing, crudStoreListingEvent, isPendingGithubRepoId } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import type { ProjectJobStep } from "@lib/dao/projectJob/crud"
import type { JobHandler } from "./worker"
import {
  applyCatalogueTemplate,
  catalogueTemplateContext,
  configureGeneratedInputs,
  failTemplateInstall,
  orchestrateCatalogueTemplate,
  provisionTemplateServices,
  transitionTemplateInstall,
  verifyUserInputsConfigured,
} from "./catalogue-template"
import { copyRepositorySnapshot } from "./repository-snapshot"
import { enqueue } from "./queue"

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

/**
 * How long a `project_job` may sit in `running` before another attempt may take it.
 *
 * Longer than any step here takes and shorter than a customer's patience. The steps are GitHub
 * calls and a deployment enqueue — seconds — and the only thing that legitimately stretches them is
 * a rate limit, which the client already waits out.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000

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

type SnapshotCredentialResolvers = {
  installation: typeof organizationGitHubCredential
  user: typeof userGitHubCredential
}

/**
 * Resolve the credential that can fill a repository immediately after SproutOS creates it.
 *
 * An installation restricted to selected repositories can create a new organization repository,
 * but GitHub does not automatically add that repository to the installation's selection. The
 * broad provisioning token therefore cannot be reused for the first push. Ask GitHub for an exact
 * repository-scoped token; when the new repository is outside the installation, fall back to the
 * initiating user's repository-scoped OAuth credential.
 */
export async function snapshotWriteCredential(
  db: Kysely<DB>,
  input: {
    organizationId: string
    userId: string
    ownerLogin: string
    repositoryId: number
    provisionCredential: GitHubCredential
  },
  resolvers: SnapshotCredentialResolvers = {
    installation: organizationGitHubCredential,
    user: userGitHubCredential,
  },
): Promise<GitHubCredential> {
  if (input.provisionCredential.kind !== "installation") return input.provisionCredential

  const credential =
    (await resolvers.installation(
      db,
      input.organizationId,
      { purpose: "repository-snapshot-push", repositoryId: input.repositoryId },
      input.ownerLogin,
    )) ?? (await resolvers.user(db, input.userId))

  if (credential === undefined) throw new NoUsableCredentialError()
  return credential
}

export async function runProvision(
  db: Kysely<DB>,
  payload: ProvisionPayload,
  github?: ProvisionGitHub,
  keepAlive?: () => Promise<boolean>,
  retryOnFailure = false,
  provisionServices: typeof provisionTemplateServices = provisionTemplateServices,
): Promise<void> {
  /*
    Claim a queued job, or reclaim one abandoned mid-flight.

    `state = 'queued'` alone was the whole condition, and it strands a project permanently. There is
    no lease on a `project_job`, so a worker that claimed one and then died leaves it `running` with
    nobody working on it — and the *next* attempt of the background job finds nothing to claim,
    returns, and reports **success**. Observed exactly that way: `project.provision succeeded` on
    attempt 2 beside a `project_job` still `running`, a fork that never happened, and a project the
    customer sees as "Building" forever.

    The old comment reasoned about the right hazard — "a retry of a job whose GitHub call already
    succeeded must not run it again" — and drew the wrong line. It is correct for a *concurrent*
    second claimant, which the `queued` predicate already excludes. It is wrong for a retry after a
    crash, which is indistinguishable from the first case without a clock.

    So a `running` job is reclaimable once it has been silent for `STALE_AFTER_MS`. Re-running is
    safe for the reason the fork step already documents: GitHub returns the *existing* fork rather
    than creating a second one, and the row is written from a fresh read either way.
  */
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS)

  const claimed = await db
    .updateTable("projectJob")
    .set({
      state: "running",
      startedAt: new Date(),
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where("id", "=", payload.projectJobId)
    .where((eb) =>
      eb.or([
        eb("state", "=", "queued"),
        eb.and([eb("state", "=", "running"), eb("updatedAt", "<", staleBefore)]),
      ]),
    )
    .returningAll()
    .executeTakeFirst()

  // Finished, or running and still fresh. Neither is an error: the first is done and the second has
  // a live worker on it.
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

    /*
      The App first, then the person — the order ADR 0005 states and this path did not follow.

      Only `userGitHubCredential` was consulted here, so an organization with the App installed and
      a signed-in user whose OAuth token lacked `repo` failed with `NoUsableCredentialError` — an
      error whose own message says to install the App. It was installed. Nothing here could see it.

      Order matters beyond fixing that: an installation token is scoped to what the customer granted
      and carries its own rate limit, while the user token is broad and personal. Reaching for the
      user token first would mean the platform acting as a person whenever it happened to be able
      to, which is exactly what ADR 0005 set out to stop.
    */
    const credential =
      github?.credential ??
      (await organizationGitHubCredential(
        db,
        repository.organizationId,
        { purpose: "repository-provision" },
        repository.ownerLogin,
      )) ??
      (await userGitHubCredential(db, payload.userId))
    if (credential === undefined) throw new NoUsableCredentialError()
    const usableCredential = credential

    const client = github?.client ?? createGitHubClient()

    /*
      A repository that already exists is read, not created.

      TASK 21's "use a repository you own" writes no new `repository` row — it points a project at
      one already there — and it queues the same `provision` job as everything else. This line
      created unconditionally, so that path asked GitHub to make a repository the customer already
      had, and GitHub answered 422 "name already exists on this account". The whole third way of
      starting a project failed on its first step, every time.

      Told apart by the sign of `github_repo_id`, which is what `pendingGithubRepoId` exists to
      encode: negative while the row is a placeholder waiting on GitHub, and GitHub's own positive
      id once it is real. A boolean column would have been a second source of truth for something
      the id already says.
    */
    const template =
      job.projectId === null ? null : await catalogueTemplateContext(db, job.projectId)

    async function createOrLoadAndPersist(): Promise<GitHubRepository> {
      const created = isPendingGithubRepoId(repository.githubRepoId)
        ? await createOnGitHub(client, usableCredential, repository)
        : await getRepository(client, usableCredential, repository.ownerLogin, repository.name)
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
      const populatedCredential =
        repository.upstreamStrategy === "snapshot_copy"
          ? await snapshotWriteCredential(db, {
              organizationId: repository.organizationId,
              userId: payload.userId,
              ownerLogin: created.ownerLogin,
              repositoryId: created.id,
              provisionCredential: usableCredential,
            })
          : usableCredential
      if (repository.upstreamStrategy === "snapshot_copy") {
        if (repository.upstreamFullName === null) {
          throw new Error("snapshot copy has no upstream repository")
        }
        await copyRepositorySnapshot({
          owner: created.ownerLogin,
          repo: created.name,
          branch: created.defaultBranch,
          upstreamFullName: repository.upstreamFullName,
          upstreamBranch: repository.upstreamDefaultBranch ?? "main",
          token: populatedCredential.token,
        })
      }
      await headShaWhenPopulated(
        client,
        populatedCredential,
        created.ownerLogin,
        created.name,
        created.defaultBranch,
      )
      await mark(createStep, "succeeded")
      return created
    }

    if (template === null) {
      await createOrLoadAndPersist()
    } else {
      await orchestrateCatalogueTemplate({
        transition: async (state) => {
          await transitionTemplateInstall(db, template.projectId, state)
          await db
            .updateTable("project")
            .set({
              state: state === "deploying" ? "deploying" : "provisioning",
              stateReason: null,
              updatedAt: new Date(),
            })
            .where("id", "=", template.projectId)
            .execute()
        },
        configure: async () => {
          await verifyUserInputsConfigured(db, template)
          await configureGeneratedInputs(db, template)
        },
        provisionServices: async () => {
          await provisionServices(db, template, keepAlive)
        },
        fork: createOrLoadAndPersist,
        prepareAndPush: async (preparedRepository) => {
          if (template.preparedCommitSha !== null) return
          const templateCredential =
            usableCredential.kind === "installation"
              ? await organizationGitHubCredential(
                  db,
                  repository.organizationId,
                  {
                    purpose: "catalogue-template-push",
                    repositoryId: preparedRepository.id,
                  },
                  preparedRepository.ownerLogin,
                )
              : usableCredential
          if (templateCredential === undefined) {
            throw new NoUsableCredentialError()
          }
          await applyCatalogueTemplate({
            db,
            context: template,
            owner: preparedRepository.ownerLogin,
            repository: preparedRepository.name,
            branch: preparedRepository.defaultBranch,
            token: templateCredential.token,
          })
        },
      })
    }

    /*
      The first deploy, which this job cannot perform.

      The comment that used to sit here said everything downstream already worked — "`release` finds
      no image, enqueues the build, and the build enqueues the deploy back". That was true under
      Knative. ADR 0026 moved compute to Lambda, and a release now carries an *artifact* uploaded by
      the deploy action before the release call. There is no build for this job to trigger.

      So the two calls it made produced a `deployment` row with a null `artifact_key`, which
      `publishRelease` refuses on sight — "No build artifact was uploaded for this release", not
      retried, because retrying will not make bytes appear. Every project in production carries one:
      six projects, six failed deployments, all with that reason.

      And the step was marked `succeeded` regardless. The comment above congratulated itself on
      removing exactly that lie — a progress bar reaching 100% for work nobody did — and it had
      grown back one layer down, where the step passed and the thing it stood for failed.

      Marked `skipped` with the reason, which is the honest state: the fork exists, and deploying it
      needs a workflow in the customer's repository that nothing here can write for them.
    */
    if (job.projectId !== null) {
      /*
        The head is still read, and nothing is deployed.

        Waiting for the fork to be populated is the useful half of what this step used to do: a fork
        is asynchronous on GitHub's side, and a repository that answers before its default branch
        has commits is one a customer would open to find empty. Confirming the sha is how this job
        knows the fork actually landed.

        What is dropped is the deployment row that followed, which could only ever fail.
      */
      await mark("first_deploy", template === null ? "skipped" : "succeeded")
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
      if (template === null) {
        await db
          .updateTable("project")
          .set({ state: "ready", updatedAt: new Date() })
          .where("id", "=", job.projectId)
          .execute()
      }

      /*
        The install, counted where an install actually happened.

        `POST /projects` used to increment `store_listing.install_count` immediately after queueing
        this job — so a fork that failed at GitHub still moved the number every store card shows.
        Here it is behind a repository that exists.

        `fork_completed` has been a permitted `store_listing_event.kind` since the first migration
        and nothing has ever written one; this is its writer.
      */
      const listing = await db
        .selectFrom("project")
        .select(["storeListingId"])
        .where("id", "=", job.projectId)
        .executeTakeFirst()

      if (listing?.storeListingId != null) {
        await crudStoreListing(db).incrementInstallCount(listing.storeListingId)
        await crudStoreListingEvent(db).record({
          kind: "fork_completed",
          storeListingId: listing.storeListingId,
          userId: payload.userId,
        })
      }

      const details =
        typeof job.details === "object" && job.details !== null
          ? (job.details as Record<string, unknown>)
          : {}
      if (details.syncUpstreamNow === true && repository.upstreamFullName !== null) {
        await enqueue(db, {
          kind: "upkeep.repository",
          organizationId: repository.organizationId,
          payload: {
            repositoryId: repository.id,
            ...(job.projectId === null ? {} : { requestedProjectId: job.projectId }),
            requestedByUserId: payload.userId,
          },
          idempotencyKey: `upkeep.repository:${repository.id}:initial`,
          maxAttempts: 2,
        })
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const running = steps.find((step) => step.state === "running")
    if (running !== undefined) await mark(running.key, retryOnFailure ? "pending" : "failed")

    await db
      .updateTable("projectJob")
      .set({
        state: retryOnFailure ? "queued" : "failed",
        errorCode: cause instanceof Error ? cause.name : "Error",
        // Recorded on the row, because this is the only place a customer can see it. A provisioning
        // failure that lives in a worker's stdout is a project stuck in `creating` with no reason.
        errorMessage: message,
        finishedAt: retryOnFailure ? null : new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", job.id)
      .execute()

    if (job.projectId !== null) {
      if (!retryOnFailure) await failTemplateInstall(db, job.projectId, cause)
      await db
        .updateTable("project")
        .set({ state: retryOnFailure ? "provisioning" : "failed", updatedAt: new Date() })
        .where("id", "=", job.projectId)
        .execute()
    }

    throw cause
  }
}

/**
 * The one GitHub call that differs per plan.
 *
 * The upstream strategy decides, not the job kind or acquisition provenance. A GitHub fork uses
 * GitHub's fork endpoint; a snapshot copy creates an ordinary empty repository and seeds it with a
 * one-commit tree snapshot; an imported repository is only loaded.
 */
async function createOnGitHub(
  client: ReturnType<typeof createGitHubClient>,
  credential: GitHubCredential,
  repository: Selectable<DB["repository"]>,
): Promise<GitHubRepository> {
  if (repository.upstreamStrategy === "github_fork") {
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

  const input = {
    name: repository.name,
    private: repository.private,
    autoInit: repository.upstreamStrategy !== "snapshot_copy",
  }

  return owner.data.type === "Organization"
    ? await createOrganizationRepository(client, credential, repository.ownerLogin, input)
    : await createPersonalRepository(client, { kind: "user", token: tokenOf(credential) }, input)
}

/*
  A repository GitHub has created and not yet filled.

  Literal forks are asynchronous, while a snapshot copy is filled by the trusted worker immediately
  after repository creation. Reading the branch head is the common completion boundary for both.

  Polled rather than slept: the wait is however long GitHub takes, and a fixed sleep is either a
  guess that is usually too long or one that is occasionally too short. Bounded, because a template
  that never populates has to end as an error rather than a job that never returns.

  Not retried at the job level either. The job's own retry would begin at `create_repository`, and
  the second attempt would find the name taken.
*/
const POPULATE_POLL_DELAYS_MS = [0, 500, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000, 5_000]

async function headShaWhenPopulated(
  client: ReturnType<typeof createGitHubClient>,
  credential: GitHubCredential,
  owner: string,
  name: string,
  branch: string,
): Promise<string> {
  let last: unknown

  for (const delay of POPULATE_POLL_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

    try {
      return await getBranchHeadSha(client, credential, owner, name, branch)
    } catch (error) {
      /*
        Only the empty case is worth waiting on. A missing scope or a bad name will read the same on
        the ninth attempt as the first, and turning those into a thirty-second pause before the same
        error is worse than failing immediately.
      */
      if (!isEmptyRepository(error)) throw error
      last = error
    }
  }

  throw last instanceof Error
    ? last
    : new Error(`${owner}/${name} was still empty after waiting for GitHub to populate it`)
}

/** GitHub says this as a 409 on a repository that exists but holds no commits. */
function isEmptyRepository(error: unknown): boolean {
  return error instanceof GitHubApiError && /repository is empty/i.test(error.message)
}

/** `createPersonalRepository` refuses anything but a user token, and says why. This narrows it. */
function tokenOf(credential: GitHubCredential): string {
  if (credential.kind !== "user") throw new NoUsableCredentialError()
  return credential.token
}

export function provisionProjectJobHandler(
  dependencies: {
    github?: ProvisionGitHub
    provisionServices?: typeof provisionTemplateServices
  } = {},
): JobHandler {
  return async (job, { db, keepAlive }) => {
    const payload = job.payload as ProvisionPayload
    await runProvision(
      db,
      payload,
      dependencies.github,
      keepAlive,
      job.attempt < job.maxAttempts,
      dependencies.provisionServices,
    )
  }
}

export const provisionProjectJob = provisionProjectJobHandler()
