import { srnFor } from "@lib/srn"
import type { DB, Json } from "@sproutos/db"
import type { Kysely, Selectable, Transaction } from "kysely"
import { crudAuditLog } from "../auditLog/crud"
import { crudProjectJob, initialSteps, type ProjectJobKind } from "../projectJob/crud"
import { crudProjectEnvVar, type SealedEnvValue } from "../projectEnvVar/crud"
import { crudProjectTemplateInstall } from "../projectTemplateInstall/crud"
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
      upstreamStrategy?: "github_fork" | "snapshot_copy" | "manual" | null
      upstreamGithubRepoId?: string | null
      upstreamFullName?: string | null
      upstreamDefaultBranch?: string | null
      githubInstallationId?: string | null
    }

export type ProvisionProjectInput = {
  /** Preallocated when envelope values must be bound to the project before its transaction. */
  projectId?: string
  organizationId: string
  actorUserId: string
  /** OAuth grant that created this project; null for a person using the dashboard. */
  createdByOauthGrantId: string | null
  name: string
  description?: string | null
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
  autoUpdateCadence: string
  autoUpdateMode: string
  syncUpstreamNow?: boolean
  storeListingId: string | null
  /** Signed catalogue snapshot consumed by the worker. Never reconstructed from a newer import. */
  templateInstall?: {
    catalogueImportId: string
    catalogueEntryId: string
    catalogueDigest: string
    manifestDigest: string
    deploymentTemplatesCommit: string
    manifest: DB["projectTemplateInstall"]["manifest"]
    pluginRepository: string
    pluginDigest: string
    configuredInputs: Json
    environmentInputs: {
      environment: string
      secret: boolean
      value: SealedEnvValue
    }[]
  }
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
  regionId?: string | null
  idempotencyKey?: string | null
  audit?: AuditContext
  auditAction?: string
  auditMetadata?: Json
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

export type RemoveProjectInput = {
  organizationId: string
  projectId: string
  actorUserId: string
  audit?: AuditContext
  preserveEmptyGroups?: boolean
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
    upstreamStrategy: input.repository.upstreamStrategy ?? null,
    githubInstallationId: input.repository.githubInstallationId ?? null,
  })
}

/**
 * Project lifecycle operations that span `repository`, `project`, `project_job`, and `audit_log`.
 *
 * The public create/remove operations open their own transactions and therefore take the pool.
 * `removeInTransaction` is the explicit composition seam for a caller that must commit several
 * removals and their background-job queue rows together. The whole reason these live together is
 * that a project row without its job is stuck forever, while a job without its project makes the
 * worker dereference null — they have to commit or fail as one.
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
        ...(input.projectId === undefined ? {} : { id: input.projectId }),
        organizationId: input.organizationId,
        repositoryId: repository.id,
        storeListingId: input.storeListingId,
        agentCredentialId: input.agentCredentialId,
        createdByOauthGrantId: input.createdByOauthGrantId,
        name: input.name,
        description: input.description ?? null,
        slug: input.slug,
        kind: input.kind,
        rootDir: input.rootDir,
        dockerfilePath: input.dockerfilePath,
        ...(input.scaleMode === undefined ? {} : { scaleMode: input.scaleMode }),
        productionBranch: input.productionBranch,
        // See `isGroup` above: a group has nothing to provision, so `creating` would never end.
        state: input.isGroup === true ? "ready" : "creating",
        autoUpdateEnabled: input.autoUpdateEnabled,
        autoUpdateCadence: input.autoUpdateCadence,
        autoUpdateMode: input.autoUpdateMode,
        isGroup: input.isGroup ?? false,
        parentProjectId: input.parentProjectId ?? null,
        regionId: input.regionId ?? null,
      })

      const job = await crudProjectJob(tx).create({
        organizationId: input.organizationId,
        projectId: project.id,
        repositoryId: repository.id,
        kind: input.jobKind,
        state: "queued",
        steps: JSON.stringify(initialSteps(input.jobKind)),
        idempotencyKey: input.idempotencyKey ?? null,
        details: input.syncUpstreamNow === true ? { syncUpstreamNow: true } : {},
      })

      if (input.templateInstall !== undefined) {
        if (input.storeListingId === null) {
          throw new Error("a template install requires a store listing")
        }
        const { environmentInputs, ...snapshot } = input.templateInstall
        await crudProjectTemplateInstall(tx).create({
          ...snapshot,
          configuredInputs: JSON.stringify(snapshot.configuredInputs),
          organizationId: input.organizationId,
          projectId: project.id,
          storeListingId: input.storeListingId,
        })
        await Promise.all(
          environmentInputs.map(async (environmentInput) => {
            await crudProjectEnvVar(tx).upsert({
              projectId: project.id,
              key: environmentInput.environment,
              target: "all",
              isSecret: environmentInput.secret,
              value: environmentInput.value,
            })
          }),
        )
      }

      await crudAuditLog(tx).record({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: input.auditAction ?? "project:create",
        resourceSrn: srnFor("project", input.organizationId, "project", project.id),
        before: null,
        after: {
          slug: project.slug,
          kind: project.kind,
          repositoryId: repository.id,
          repositoryMode: input.repository.mode,
          storeListingId: input.storeListingId,
          autoUpdateEnabled: project.autoUpdateEnabled,
          autoUpdateCadence: project.autoUpdateCadence,
          jobId: job.id,
          ...(input.auditMetadata === undefined ? {} : { operationMetadata: input.auditMetadata }),
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
  async function removeInTransaction(
    tx: Transaction<DB>,
    input: RemoveProjectInput,
  ): Promise<DeletedProject | null> {
    const project = await crudProject(tx).softDelete(input.organizationId, input.projectId)
    if (project === undefined) return null

    /*
        Deployable siblings, not every row.

        A repository now starts as a group with its projects inside it, so counting groups here
        would mean the last project's deletion still found one sibling — the container — and the
        repository could never be released. The group would outlive everything it contained and hold
        a repository nobody uses.
      */
    let siblingsQuery = tx
      .selectFrom("project")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("repositoryId", "=", project.repositoryId)
      .where("deletedAt", "is", null)
    /*
        During a recursive group deletion, live groups are real siblings, not cleanup residue.

        Counting only deployables would release the repository as soon as the deepest leaf went
        away, while its ancestor groups were still being prepared — and could soft-delete an
        unrelated sibling group without giving it a teardown job. Ordinary single-project deletion
        keeps the historical deployable-only count so its implicit empty repository group is still
        cleaned up automatically.
      */
    if (input.preserveEmptyGroups !== true) {
      siblingsQuery = siblingsQuery.where("isGroup", "=", false)
    }
    const siblings = await siblingsQuery.executeTakeFirst()

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
      if (input.preserveEmptyGroups !== true) {
        await tx
          .updateTable("project")
          .set({ deletedAt: new Date(), state: "deleting" })
          .where("repositoryId", "=", project.repositoryId)
          .where("isGroup", "=", true)
          .where("deletedAt", "is", null)
          .execute()
      }

      await crudRepository(tx).softDelete(project.repositoryId)
    }

    const job = await crudProjectJob(tx).create({
      organizationId: input.organizationId,
      projectId: project.id,
      repositoryId: project.repositoryId,
      kind: "delete",
      state: "queued",
      deletionReason: "user_requested",
      serviceCutoffAt: project.deletedAt,
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
  }

  async function remove(input: RemoveProjectInput): Promise<DeletedProject | null> {
    return await db.transaction().execute(async (tx) => await removeInTransaction(tx, input))
  }

  return { create, remove, removeInTransaction }
}
