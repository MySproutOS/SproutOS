import { open } from "@lib/envelope"
import {
  createGitHubClient,
  createOrganizationRepository,
  createPersonalRepository,
  forkRepository,
  generateFromTemplate,
  getRepository,
  type GitHubCredential,
  type GitHubRepository,
} from "@lib/github"
import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import type { ProjectJobStep } from "@lib/dao/projectJob/crud"
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

/**
 * The scope a repository operation needs from a *user* token.
 *
 * GitHub has no finer-grained OAuth App scope, which is why the identity login deliberately does
 * not ask for it and why this is checked rather than assumed: a token without it fails with a 404
 * on a private repository, not a 403, and a 404 sends the reader looking for a typo.
 */
const REPOSITORY_SCOPE = "repo"

/**
 * The user's GitHub token, decrypted, if it can do repository work.
 *
 * Returns `undefined` rather than throwing when the scope is missing, so the caller can fall back
 * to an installation token before giving up.
 */
async function userCredential(
  db: Kysely<DB>,
  userId: string,
): Promise<GitHubCredential | undefined> {
  const account = await db
    .selectFrom("account")
    .select(["accessTokenCiphertext", "accessTokenWrappedDek", "accessTokenKmsKeyId", "scopes"])
    .where("userId", "=", userId)
    .where("provider", "=", "github")
    .executeTakeFirst()

  if (account?.accessTokenCiphertext == null) return undefined
  if (account.accessTokenWrappedDek == null || account.accessTokenKmsKeyId == null) return undefined
  if (!account.scopes.includes(REPOSITORY_SCOPE)) return undefined

  const token = await open(
    {
      ciphertext: account.accessTokenCiphertext,
      wrappedDek: account.accessTokenWrappedDek,
      kmsKeyId: account.accessTokenKmsKeyId,
    },
    { userId, provider: "github", field: "access_token" },
  )

  return { kind: "user", token }
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
export async function runProvision(db: Kysely<DB>, payload: ProvisionPayload): Promise<void> {
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

    const credential = await userCredential(db, payload.userId)
    if (credential === undefined) throw new NoUsableCredentialError()

    const client = createGitHubClient()
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
      The remaining three steps are honestly `skipped`, not `succeeded`.

      Linking an installation needs a GitHub App private key this deployment does not have;
      detecting build settings is the TASK 38/39 analyzer; the first deploy is the build pipeline.
      Each exists elsewhere in the repository and none is wired to this job yet. Marking them
      `succeeded` would be the same lie the whole job used to tell — a progress bar reaching 100%
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
