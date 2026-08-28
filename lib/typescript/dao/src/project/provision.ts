import { srnFor } from "@lib/srn"
import type { DB } from "@sproutos/db"
import type { Kysely, Selectable, Transaction } from "kysely"
import { crudAuditLog } from "../auditLog/crud"
import { crudProjectJob, initialSteps, type ProjectJobKind } from "../projectJob/crud"
import { crudRepository } from "../repository/crud"
import type { AuditContext } from "../organization/provision"
import { crudProject } from "./crud"

/**
 * How the project gets a repository.
 *
 * `existing` is TASK 21: two projects on one repository, differing by directory or branch. It is
 * a distinct case rather than a lookup inside `create`, because reusing a repository must not
 * write a `repository` row at all — a second row for the same GitHub repo would give upkeep two
 * places to run and two places to disagree.
 */
export type RepositoryPlan =
  | { mode: "existing"; id: string }
  | {
      mode: "create"
      provenance: "fork" | "template" | "new" | "imported" | "copy"
      ownerLogin: string
      name: string
      defaultBranch: string
      private: boolean
      isFork: boolean
      upstreamGithubRepoId?: string | null
      upstreamFullName?: string | null
      upstreamDefaultBranch?: string | null
      githubInstallationId?: string | null
    }

export type ProvisionProjectInput = {
  organizationId: string
  actorUserId: string
  /** OAuth grant that created this project; null for a person using the dashboard. */
  createdByOauthGrantId: string | null
  name: string
  slug: string
  kind: string
  rootDir: string
  /** Relative to `rootDir`. Defaulted by the caller from the store listing, or to `Dockerfile`. */
  dockerfilePath: string
  /** `cold` scales to zero, `warm` keeps one. Omitted takes the column default, which is `cold`. */
  scaleMode?: string
  productionBranch: string
  agentCredentialId: string | null
  autoUpdateEnabled: boolean
  autoUpdateMode: string
  storeListingId: string | null
  repository: RepositoryPlan
  jobKind: ProjectJobKind
  /**
   * Create this as a logical grouping.
   *
   * A group is `state: "ready"` from the moment it exists, because there is nothing to provision —
   * no repository to fork, no build, no function. Leaving it `creating` like a deployable project
   * would leave it permanently mid-provision, waiting on a job that has no work to do.
   */
  isGroup?: boolean
  parentProjectId?: string | null
  idempotencyKey?: string | null
  audit?: AuditContext
}

export type ProvisionedProject = {
  project: Selectable<DB["project"]>
  repository: Selectable<DB["repository"]>
  job: Selectable<DB["projectJob"]>
}

export type DeletedProject = {
  project: Selectable<DB["project"]>
  job: Selectable<DB["projectJob"]>
  repositoryReleased: boolean
  remainingProjectsOnRepository: number
}

/**
 * Resolves the repository a new project will hang off.
 *
 * `existing` writes nothing — TASK 21's shared repository must stay one row, or upkeep would have
 * two places to run and two places to disagree. `create` writes a placeholder whose
 * `github_repo_id` is negative until the provisioning job hears back from GitHub.
 */
async function resolveRepository(
  tx: Transaction<DB>,
  input: ProvisionProjectInput,
): Promise<Selectable<DB["repository"]>> {
  if (input.repository.mode === "existing") {
    const existing = await tx
      .selectFrom("repository")
      .selectAll()
      .where("id", "=", input.repository.id)
      .where("organizationId", "=", input.organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (existing === undefined) throw new Error("repository not found in this organization")
    return existing
  }

  return await crudRepository(tx).createPending({
    organizationId: input.organizationId,
    ownerLogin: input.repository.ownerLogin,
    name: input.repository.name,
    defaultBranch: input.repository.defaultBranch,
    private: input.repository.private,
    isFork: input.repository.isFork,
    provenance: input.repository.provenance,
    upstreamGithubRepoId: input.repository.upstreamGithubRepoId ?? null,
    upstreamFullName: input.repository.upstreamFullName ?? null,
    upstreamDefaultBranch: input.repository.upstreamDefaultBranch ?? null,
    githubInstallationId: input.repository.githubInstallationId ?? null,
  })
}

/**
 * Project lifecycle operations that span `repository`, `project`, `project_job`, and `audit_log`.
 *
 * Each opens its own transaction and therefore takes the pool, not a transaction handle. The
 * whole reason these live together is that a project row without its job is a project stuck in
 * `creating` forever, and a job without its project is a worker dereferencing null — they have to
 * commit or fail as one.
 */
export function provisionProject(db: Kysely<DB>) {
  /**
   * Creates the project row and the job that will actually build it.
   *
   * The row lands in `state: 'creating'` before anything has been asked of GitHub. That ordering
   * is deliberate: a fork takes seconds to minutes and GitHub answers `202` before the repository
   * is clonable, so doing it inside the request would mean a request that times out and a
   * repository nobody has a row for.
   */
  async function create(input: ProvisionProjectInput): Promise<ProvisionedProject> {
    return await db.transaction().execute(async (tx) => {
      const repository = await resolveRepository(tx, input)

      const project = await crudProject(tx).create({
        organizationId: input.organizationId,
        repositoryId: repository.id,
        storeListingId: input.storeListingId,
        agentCredentialId: input.agentCredentialId,
        createdByOauthGrantId: input.createdByOauthGrantId,
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        rootDir: input.rootDir,
        dockerfilePath: input.dockerfilePath,
        ...(input.scaleMode === undefined ? {} : { scaleMode: input.scaleMode }),
        productionBranch: input.productionBranch,
        // See `isGroup` above: a group has nothing to provision, so `creating` would never end.
        state: input.isGroup === true ? "ready" : "creating",
        autoUpdateEnabled: input.autoUpdateEnabled,
        autoUpdateMode: input.autoUpdateMode,
        isGroup: input.isGroup ?? false,
        parentProjectId: input.parentProjectId ?? null,
      })

      const job = await crudProjectJob(tx).create({
        organizationId: input.organizationId,
        projectId: project.id,
        repositoryId: repository.id,
        kind: input.jobKind,
        state: "queued",
        steps: JSON.stringify(initialSteps(input.jobKind)),
        idempotencyKey: input.idempotencyKey ?? null,
      })

      await crudAuditLog(tx).record({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "project:create",
        resourceSrn: srnFor("project", input.organizationId, "project", project.id),
        before: null,
        after: {
          slug: project.slug,
          kind: project.kind,
          repositoryId: repository.id,
          repositoryMode: input.repository.mode,
          storeListingId: input.storeListingId,
          autoUpdateEnabled: project.autoUpdateEnabled,
          jobId: job.id,
        },
        ...input.audit,
      })

      return { job, project, repository }
    })
  }

  /**
   * Soft-deletes a project and queues its teardown.
   *
   * Nothing external is destroyed here and nothing in the ledger is touched — `usage_event`,
   * `usage_rollup`, and `statement_line_item` all point at this project with `ON DELETE RESTRICT`
   * precisely so that last month's statement can still name it (ADR 0017).
   *
   * The repository is released only when this was the last live project on it. TASK 21 allows
   * several projects to share one, and deleting the first would otherwise take the repository —
   * and therefore upkeep — away from the others.
   */
  async function remove(input: {
    organizationId: string
    projectId: string
    actorUserId: string
    audit?: AuditContext
  }): Promise<DeletedProject | null> {
    return await db.transaction().execute(async (tx) => {
      const project = await crudProject(tx).softDelete(input.organizationId, input.projectId)
      if (project === undefined) return null

      /*
        Deployable siblings, not every row.

        A repository now starts as a group with its projects inside it, so counting groups here
        would mean the last project's deletion still found one sibling — the container — and the
        repository could never be released. The group would outlive everything it contained and hold
        a repository nobody uses.
      */
      const siblings = await tx
        .selectFrom("project")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("repositoryId", "=", project.repositoryId)
        .where("deletedAt", "is", null)
        .where("isGroup", "=", false)
        .executeTakeFirst()

      const remaining = siblings ? Number(siblings.count) : 0
      const repositoryReleased = remaining === 0

      if (repositoryReleased) {
        /*
          The empty groups go with it.

          A group with no projects is not something anyone asked for — it is the residue of the last
          one being deleted. Soft-deleted rather than removed, like everything else here, so an
          audit row that references it still resolves. `ON DELETE RESTRICT` on `parent_project_id`
          is untouched by this: a soft delete is an UPDATE.
        */
        await tx
          .updateTable("project")
          .set({ deletedAt: new Date(), state: "deleting" })
          .where("repositoryId", "=", project.repositoryId)
          .where("isGroup", "=", true)
          .where("deletedAt", "is", null)
          .execute()

        await crudRepository(tx).softDelete(project.repositoryId)
      }

      const job = await crudProjectJob(tx).create({
        organizationId: input.organizationId,
        projectId: project.id,
        repositoryId: project.repositoryId,
        kind: "delete",
        state: "queued",
        steps: JSON.stringify(initialSteps("delete")),
      })

      await crudAuditLog(tx).record({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "project:delete",
        resourceSrn: srnFor("project", input.organizationId, "project", project.id),
        before: { slug: project.slug, state: "ready", deletedAt: null },
        after: {
          state: project.state,
          deletedAt: project.deletedAt?.toISOString() ?? null,
          repositoryReleased,
          remainingProjectsOnRepository: remaining,
          teardownJobId: job.id,
        },
        ...input.audit,
      })

      return { job, project, remainingProjectsOnRepository: remaining, repositoryReleased }
    })
  }

  return { create, remove }
}
