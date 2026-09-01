import {
  openEnvVarValue,
  openProjectFileContents,
  sealEnvVarValue,
  sealProjectFileContents,
} from "@lib/envelope"
import {
  GITHUB_EVENT_KINDS,
  installationDiscoveryIdempotencyKey,
  JOB_KINDS,
  enqueue,
  manifestDigestForCatalogueEntry,
  parseCatalogueAppManifest,
  validateCatalogueUserInputs,
} from "@lib/jobs"
import {
  allocateProjectSlug,
  autoUpdateDefaultFor,
  crudAuditLog,
  crudAgentSession,
  crudProject,
  crudProjectEnvVar,
  crudProjectFile,
  crudProjectJob,
  crudProjectUpdateSuggestion,
  crudStoreListingEvent,
  fetchAgentCredential,
  fetchDeploymentCatalogueImport,
  fetchGithubInstallation,
  fetchProject,
  fetchProjectEnvVar,
  fetchProjectFile,
  fetchProjectJob,
  fetchProjectUpdateSuggestion,
  crudRepository,
  fetchRepository,
  fetchStoreListing,
  fetchUser,
  initialSteps,
  isPendingGithubRepoId,
  isValidProjectSlug,
  type ProjectJobKind,
  type ProjectJobStep,
  provisionProject,
  type RepositoryPlan,
} from "@lib/dao"
import {
  createGitHubClient,
  GitHubNotFoundError,
  getRepository,
  getRepositoryById,
  organizationGitHubCredential,
} from "@lib/github"
import { rateProjectsForOrganization, startOfMonth } from "@lib/billing/usage"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import type { DB } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { sql, type Kysely, type Selectable } from "kysely"
import type { Context } from "hono"
import { authMiddleware } from "../middleware"
import {
  collectionResource,
  paramResource,
  type PermissionVariables,
  requirePermission,
} from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwError, throwNotFound } from "../utils/http-exception"
import { cursorPaginate, decodeCursor } from "../utils/pagination"
import { auditContext } from "../utils/request-context"
import {
  projectSchemaCreateRequest,
  projectSchemaCreateResponse,
  projectSchemaDeleteResponse,
  projectSchemaEntryResponse,
  projectSchemaEnvVarListResponse,
  projectSchemaEnvVarParam,
  projectSchemaEnvVarRequest,
  projectSchemaEnvVarResponse,
  projectSchemaEnvVarRevealResponse,
  projectSchemaFileListResponse,
  projectSchemaFileParam,
  projectSchemaFileRequest,
  projectSchemaFileResponse,
  projectSchemaFileRevealResponse,
  projectSchemaIdParam,
  projectSchemaJobListResponse,
  projectSchemaJobParam,
  projectSchemaJobResponse,
  projectSchemaListQuery,
  projectSchemaListResponse,
  projectSchemaOrgParam,
  projectSchemaResponse,
  projectSchemaSuggestionListQuery,
  projectSchemaSuggestionListResponse,
  projectSchemaSuggestionParam,
  projectSchemaSuggestionResponse,
  projectSchemaUpdateRequest,
  repositorySchemaListQuery,
  repositorySchemaListResponse,
} from "./projects.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const notFoundResponse = {
  description: "No such organization, or the caller is not a member",
  ...errorResponse,
}

type ProjectRow = {
  id: string
  repositoryId: string
  kind: string
  regionId?: string | null
  primaryChildProjectId?: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Adds what the project list actually shows: what it has cost, where it runs, and whether its
 * upstream has moved.
 *
 * Batched lookups for the whole page rather than per-project lookups. A dashboard with thirty
 * projects would otherwise make hundreds of round trips to render one screen, and none needs to
 * know about any single project to answer for all of them.
 */
async function enrich<T extends ProjectRow>(organizationId: string, rows: readonly T[]) {
  if (rows.length === 0) return []
  const projectIds = rows.map((row) => row.id)

  const [rated, regions, behind, live, domains, managers, primary] = await Promise.all([
    /*
      Rated at read time against the price book in force, never stored. A stored cost is wrong the
      moment a rate changes, and wrong in a way nobody can reconstruct.

      A deployment with no price book seeded is a seeding bug that would otherwise show every
      customer a free product; `rateProjectsForOrganization` throws, and this lets it.
    */
    rateProjectsForOrganization(db, organizationId, startOfMonth()),

    /* The persisted workload region, including a group's default for newly created children. */
    db
      .selectFrom("project")
      .innerJoin("region", "region.id", "project.regionId")
      .select(["project.id as projectId", "region.code as code"])
      .where("project.id", "in", projectIds)
      .execute(),

    /*
      TASK 17's "your fork is behind" flag, from the most recent sync run per repository.

      `behind_by > 0` on the *latest* run, not on any run: a repository that was behind last week
      and has since been merged is not behind now, and a flag that lit up on history would never go
      out.
    */
    db
      .selectFrom("upstreamSyncRun")
      // `distinct on` is Postgres's "one row per group", and the order clause is what picks *which*
      // row — the leading key must match the distinct key or the result is arbitrary.
      .distinctOn("repositoryId")
      .select(["repositoryId", "behindBy"])
      .where(
        "repositoryId",
        "in",
        rows.map((row) => row.repositoryId),
      )
      .orderBy("repositoryId")
      .orderBy("createdAt", "desc")
      .execute(),

    /*
      Where each project is actually reachable.

      From `project.live_deployment_id`, not from the newest deployment row. A deploy that failed
      does not move a project's URL, and reading the most recent row would claim it did — the
      customer would be shown a hostname belonging to a release that never served.

      One query for the page, same as the other three.
    */
    db
      .selectFrom("project")
      .innerJoin("deployment", "deployment.id", "project.liveDeploymentId")
      .select([
        "project.id as projectId",
        "deployment.url as url",
        "deployment.hostname as hostname",
      ])
      .where("project.id", "in", projectIds)
      .where("deployment.deletedAt", "is", null)
      .execute(),
    /*
      A serving custom hostname is the customer's primary address.

      The group-primary query already knew this, but ordinary projects did not: the list therefore
      showed the generated sproutos.run deployment while the project detail showed its custom
      domain. A renewal warning still represents a serving certificate and must not cause fallback.
    */
    db
      .selectFrom("customDomain")
      .select(["projectId", "hostname", "createdAt"])
      .where("projectId", "in", projectIds)
      .where("status", "in", ["active", "renewal_warning"])
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "asc")
      .execute(),
    db
      .selectFrom("project")
      .innerJoin("oauthGrant", "oauthGrant.id", "project.createdByOauthGrantId")
      .innerJoin("oauthClient", "oauthClient.id", "oauthGrant.oauthClientId")
      .select(["project.id as projectId", "oauthClient.id as clientId", "oauthClient.name as name"])
      .where("project.id", "in", projectIds)
      .execute(),
    db
      .selectFrom("project as groupProject")
      .innerJoin("project as childProject", "childProject.id", "groupProject.primaryChildProjectId")
      .leftJoin("deployment", "deployment.id", "childProject.liveDeploymentId")
      .leftJoin("customDomain", (join) =>
        join
          .onRef("customDomain.projectId", "=", "childProject.id")
          .on("customDomain.status", "in", ["active", "renewal_warning"])
          .on("customDomain.deletedAt", "is", null),
      )
      .select([
        "groupProject.id as groupProjectId",
        "childProject.kind as childKind",
        "deployment.url as url",
        "deployment.hostname as hostname",
        "customDomain.hostname as customHostname",
      ])
      .where("groupProject.id", "in", projectIds)
      .where("childProject.deletedAt", "is", null)
      .orderBy("customDomain.createdAt", "asc")
      .execute(),
  ])

  // Keeping maps makes every enrichment a single lookup while serializing the project rows.
  const regionByProject = new Map<string, string>()
  for (const row of regions) {
    if (row.projectId !== null && !regionByProject.has(row.projectId)) {
      regionByProject.set(row.projectId, row.code)
    }
  }
  const behindByRepository = new Map(behind.map((row) => [row.repositoryId, row.behindBy]))
  const liveByProject = new Map(live.map((row) => [row.projectId, row]))
  // Rows are oldest-first and later assignments win, matching the detail screen's newest domain.
  const customHostnameByProject = new Map(
    domains.map((domain) => [domain.projectId, domain.hostname]),
  )
  const managerByProject = new Map(
    managers.map((row) => [row.projectId, { clientId: row.clientId, name: row.name }]),
  )
  const primaryByGroup = new Map<
    string,
    { primaryUrl: string | null; primaryHostname: string | null }
  >()
  for (const target of primary) {
    if (target.childKind === "workflow") continue
    const hostname = target.customHostname ?? target.hostname ?? null
    primaryByGroup.set(target.groupProjectId, {
      primaryHostname: hostname,
      primaryUrl:
        target.customHostname === null ? (target.url ?? null) : `https://${target.customHostname}`,
    })
  }

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Absent from the rating map means no metered usage, which is genuinely zero rather than
    // unknown — nothing has been recorded against this project.
    costMicroUsd: (rated.get(row.id)?.total ?? 0n).toString(),
    region: regionByProject.get(row.id) ?? null,
    hasUpstreamUpdate: (behindByRepository.get(row.repositoryId) ?? 0) > 0,
    url:
      row.kind === "workflow"
        ? null
        : customHostnameByProject.has(row.id)
          ? `https://${customHostnameByProject.get(row.id)}`
          : (liveByProject.get(row.id)?.url ?? null),
    hostname:
      row.kind === "workflow"
        ? null
        : (customHostnameByProject.get(row.id) ?? liveByProject.get(row.id)?.hostname ?? null),
    managedByOauthApp: managerByProject.get(row.id) ?? null,
    primaryUrl: primaryByGroup.get(row.id)?.primaryUrl ?? null,
    primaryHostname: primaryByGroup.get(row.id)?.primaryHostname ?? null,
  }))
}

const PROJECT_FIELDS = [
  "id",
  "name",
  "description",
  "slug",
  "kind",
  "state",
  "stateReason",
  "rootDir",
  "dockerfilePath",
  "scaleMode",
  "productionBranch",
  "autoUpdateEnabled",
  "autoUpdateCadence",
  "autoUpdateMode",
  "repositoryId",
  "storeListingId",
  "agentCredentialId",
  "isGroup",
  "servingMode",
  "parentProjectId",
  "createdByOauthGrantId",
  "primaryChildProjectId",
  "regionId",
  "liveDeploymentId",
  "createdAt",
  "updatedAt",
] as const

const JOB_FIELDS = [
  "id",
  "projectId",
  "kind",
  "state",
  "progress",
  "attempt",
  "errorCode",
  "errorMessage",
  "steps",
  "startedAt",
  "finishedAt",
  "createdAt",
] as const

/**
 * Nothing the ledger points at is destroyed by a delete, and nothing outside the database is
 * destroyed by the request. ADR 0017: `usage_rollup` and `statement_line_item` reference `project`
 * with `ON DELETE RESTRICT`, so last month's statement can still resolve its line items to a named
 * project.
 */
const RETAINED_ON_DELETE = ["usage_rollup", "statement_line_item", "audit_log"] as const

const TORN_DOWN_BY_JOB = [
  "deployment",
  "backend_service",
  "database_instance",
  "cache_namespace",
  "search_tenant",
  "sandbox",
  "tenant_queue",
  "observability_stream",
  "project_env_var",
  "custom_domain",
  "database_branch",
] as const

type JobRow = Pick<Selectable<DB["projectJob"]>, (typeof JOB_FIELDS)[number]>

function serializeJob(job: JobRow) {
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    attempt: job.attempt,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    steps: (Array.isArray(job.steps) ? job.steps : []) as ProjectJobStep[],
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  }
}

/**
 * Collects every live descendant before deletion, with children before their parents.
 *
 * The complete walk happens before the first row is changed. That matters for nested groups: once
 * a child is soft-deleted it disappears from `listChildren`, so discovering and deleting in the
 * same shallow loop can strand grandchildren permanently. The path guard turns corrupt cyclic
 * topology into a loud failure instead of unbounded recursion.
 */
async function listDescendantsDeepestFirst(
  database: Kysely<DB>,
  organizationId: string,
  rootProjectId: string,
): Promise<{ id: string; isGroup: boolean }[]> {
  const ordered: { id: string; isGroup: boolean }[] = []
  const path = new Set([rootProjectId])
  const visited = new Set<string>()

  async function visit(parentProjectId: string): Promise<void> {
    const children = await fetchProject(database).listChildren(organizationId, parentProjectId, [
      "id",
      "isGroup",
    ])
    for (const child of children) {
      if (path.has(child.id)) {
        throw new Error(`Project group topology contains a cycle at ${child.id}`)
      }
      if (visited.has(child.id)) continue

      path.add(child.id)
      await visit(child.id)
      path.delete(child.id)
      visited.add(child.id)
      ordered.push(child)
    }
  }

  await visit(rootProjectId)
  return ordered
}

function serializeProject(
  project: Pick<Selectable<DB["project"]>, (typeof PROJECT_FIELDS)[number]>,
  repository: { ownerLogin: string; name: string; provenance: string },
  managedByOauthApp: { clientId: string; name: string } | null = null,
) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    slug: project.slug,
    kind: project.kind,
    state: project.state,
    stateReason: project.stateReason,
    rootDir: project.rootDir,
    dockerfilePath: project.dockerfilePath,
    scaleMode: project.scaleMode,
    productionBranch: project.productionBranch,
    autoUpdateEnabled: project.autoUpdateEnabled,
    autoUpdateCadence: project.autoUpdateCadence,
    autoUpdateMode: project.autoUpdateMode,
    repositoryId: project.repositoryId,
    storeListingId: project.storeListingId,
    agentCredentialId: project.agentCredentialId,
    isGroup: project.isGroup,
    servingMode: project.servingMode,
    parentProjectId: project.parentProjectId,
    managedByOauthApp,
    primaryChildProjectId: project.primaryChildProjectId,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    repositoryOwnerLogin: repository.ownerLogin,
    repositoryName: repository.name,
    repositoryProvenance: repository.provenance,
  }
}

/**
 * One project, with the same three enrichments the list gets.
 *
 * Routed through `enrich` rather than reimplemented so a project cannot show one cost on the list
 * and a different one on its own page. It costs three queries for one row, which is the right trade
 * for a detail view rendered once.
 */
async function serializeOneProject(
  organizationId: string,
  project: Pick<Selectable<DB["project"]>, (typeof PROJECT_FIELDS)[number]>,
  repository: { ownerLogin: string; name: string; provenance: string },
) {
  const [enriched] = await enrich(organizationId, [
    { ...project, id: project.id, repositoryId: project.repositoryId },
  ])
  return {
    ...serializeProject(project, repository, enriched?.managedByOauthApp ?? null),
    costMicroUsd: enriched?.costMicroUsd ?? "0",
    region: enriched?.region ?? null,
    hasUpstreamUpdate: enriched?.hasUpstreamUpdate ?? false,
    url: enriched?.url ?? null,
    hostname: enriched?.hostname ?? null,
    primaryUrl: enriched?.primaryUrl ?? null,
    primaryHostname: enriched?.primaryHostname ?? null,
    liveDeploymentId: project.liveDeploymentId,
  }
}

/**
 * Accept and dismiss are the same conditional update with a different terminal status.
 *
 * The update is conditional on `status = 'pending'`, so two people clicking the same card produce
 * one resolution and one sync job rather than two pull requests. Accepting queues the work per
 * *repository* — the sync run compares one repo against upstream — while the suggestion it
 * resolves belongs to one project, which is the split TASK 21 requires.
 */
async function resolveSuggestion(
  c: Context<{ Variables: PermissionVariables }>,
  status: "accepted" | "dismissed",
) {
  const user = c.var.user
  const organization = c.var.organization
  const projectId = c.req.param("projectId") ?? ""
  const suggestionId = c.req.param("suggestionId") ?? ""

  const project = await fetchProject(db).getInOrganization(organization.id, projectId, [
    "id",
    "repositoryId",
  ])
  if (!project) return throwNotFound(c, "Project not found")

  const accepted = await db.transaction().execute(async (tx) => {
    const authority = await tx
      .selectFrom("projectUpdateSuggestion")
      .innerJoin(
        "upstreamSyncRun",
        "upstreamSyncRun.id",
        "projectUpdateSuggestion.upstreamSyncRunId",
      )
      .select([
        "projectUpdateSuggestion.upstreamSyncRunId",
        "upstreamSyncRun.upstreamSha",
        "upstreamSyncRun.forkSha",
        "upstreamSyncRun.outcome",
      ])
      .where("projectUpdateSuggestion.id", "=", suggestionId)
      .where("projectUpdateSuggestion.projectId", "=", project.id)
      .where("projectUpdateSuggestion.status", "=", "pending")
      .forUpdate()
      .executeTakeFirst()
    if (authority === undefined) return undefined
    if (
      status === "accepted" &&
      (authority.outcome !== "conflict" ||
        authority.upstreamSha === null ||
        authority.forkSha === null)
    ) {
      return { invalidConflict: true as const }
    }

    const resolved = await crudProjectUpdateSuggestion(tx).resolve({
      id: suggestionId,
      projectId: project.id,
      status,
      userId: user.id,
    })
    if (resolved === undefined) return undefined

    let job: JobRow | undefined
    if (status === "accepted") {
      const idempotencyKey = `upkeep.resolve:${authority.upstreamSyncRunId}`
      // Suggestions fan out per project, but resolution is one repository operation. Serialize
      // accepts for the same immutable run before creating its one agent session.
      await sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`.execute(tx)
      job = await tx
        .selectFrom("projectJob")
        .selectAll()
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst()
      if (job === undefined) {
        const session = await crudAgentSession(tx).createSession({
          projectId: project.id,
          createdByUserId: user.id,
          title: `Resolve upstream conflict ${authority.upstreamSha!.slice(0, 12)}`,
        })
        job = await crudProjectJob(tx).enqueueOnce({
          kind: "sync_upstream",
          organizationId: organization.id,
          projectId: project.id,
          repositoryId: project.repositoryId,
          state: "queued",
          steps: JSON.stringify(initialSteps("sync_upstream")),
          idempotencyKey,
          details: {
            upstreamSyncRunId: authority.upstreamSyncRunId,
            expectedUpstreamSha: authority.upstreamSha!,
            expectedTargetSha: authority.forkSha!,
            agentSessionId: session.id,
            userId: user.id,
          },
        })
        if (job === undefined) throw new Error("upkeep resolution serialization failed")
        await enqueue(tx, {
          kind: JOB_KINDS.upkeepResolveConflict,
          organizationId: organization.id,
          payload: { projectJobId: job.id },
          idempotencyKey: `${JOB_KINDS.upkeepResolveConflict}:${authority.upstreamSyncRunId}`,
          maxAttempts: 3,
        })
      }
    }

    await crudAuditLog(tx).record({
      action: "project:update",
      actorUserId: user.id,
      after: {
        status: resolved.status,
        syncJobId: job?.id ?? null,
        upstreamSyncRunId: authority.upstreamSyncRunId,
        expectedUpstreamSha: authority.upstreamSha,
        expectedTargetSha: authority.forkSha,
      },
      before: { status: "pending" },
      organizationId: organization.id,
      resourceSrn: srnFor("project", organization.id, "update_suggestion", resolved.id),
      ...auditContext(c),
    })
    return { invalidConflict: false as const, resolved, job }
  })
  if (accepted === undefined) return throwNotFound(c, "No pending suggestion with that id")
  if (accepted.invalidConflict) {
    return throwBadRequest(c, "Only a recorded conflict can be accepted for agent resolution")
  }
  const { resolved } = accepted

  const detail = await fetchProjectUpdateSuggestion(db)
    .listForProjectQuery(project.id)
    .where("projectUpdateSuggestion.id", "=", resolved.id)
    .executeTakeFirst()

  if (detail === undefined) return throwNotFound(c, "No pending suggestion with that id")

  return c.json({
    ...detail,
    createdAt: detail.createdAt.toISOString(),
    resolvedAt: detail.resolvedAt?.toISOString() ?? null,
  })
}

/**
 * The repository behind "use a repository you own".
 *
 * Two ways in, because there are two kinds of caller. Something that already holds one of this
 * platform's `repository` rows names it by id. The dashboard's picker does not: it lists what the
 * organization's installation can reach, and a customer's own repositories are not rows here until
 * they are used. It sent GitHub's numeric id in the `repositoryId` field, which is validated as a
 * UUID — so every attempt failed at the validator, and the third way of starting a project was
 * unreachable from the interface built for it.
 *
 * The import is authorized by the read itself. The lookup uses the organization's *installation*
 * credential, which can only see repositories the customer granted the App — so a successful read
 * is proof this organization may use it. Resolving a name the browser supplied would be trusting
 * the browser for exactly the thing that must not be trusted.
 */
async function resolveOwnRepository(
  organizationId: string,
  source: { repositoryId?: string; githubRepoId?: string; upstreamFullName?: string },
): Promise<{ id: string; defaultBranch: string } | undefined> {
  if (source.repositoryId !== undefined) {
    const known = await fetchRepository(db).getInOrganization(organizationId, source.repositoryId, [
      "id",
      "defaultBranch",
      "githubRepoId",
    ])
    if (known === undefined || source.upstreamFullName === undefined) return known
    return await resolveOwnRepository(organizationId, {
      githubRepoId: String(known.githubRepoId),
      upstreamFullName: source.upstreamFullName,
    })
  }

  const githubRepoId = source.githubRepoId
  if (githubRepoId === undefined) return undefined

  const known = await fetchRepository(db).getByGithubRepoId(organizationId, githubRepoId, [
    "id",
    "defaultBranch",
    "upstreamFullName",
  ])
  if (known && source.upstreamFullName === undefined) return known
  if (
    known !== undefined &&
    known.upstreamFullName !== null &&
    known.upstreamFullName !== source.upstreamFullName
  ) {
    return undefined
  }

  const repositoryId = Number(githubRepoId)
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return undefined
  const credential = await organizationGitHubCredential(db, organizationId, {
    purpose: "project-repository-read",
    repositoryId,
  })
  if (credential === undefined || credential.kind !== "installation") return undefined

  /*
    The installation is provenance too. Without this foreign key the import succeeds and the
    project points at the right fork, but every later headless operation fails because it cannot
    mint the repository-scoped credential that authorized this read.
  */
  const installation = await fetchGithubInstallation(db).getByInstallationId(
    organizationId,
    String(credential.installationId),
    ["id"],
  )
  if (installation === undefined) return undefined

  const client = createGitHubClient()
  const repository = await getRepositoryById(client, credential, githubRepoId)
  let manualUpstream: { id: number; fullName: string; defaultBranch: string } | null = null
  if (repository.parent === null && source.upstreamFullName !== undefined) {
    const [owner, name] = source.upstreamFullName.split("/")
    if (owner === undefined || name === undefined) return undefined
    let inspected
    try {
      inspected = await getRepository(client, credential, owner, name)
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return undefined
      throw error
    }
    if (inspected.id === repository.id) return undefined
    manualUpstream = {
      id: inspected.id,
      fullName: inspected.fullName,
      defaultBranch: inspected.defaultBranch,
    }
  }

  if (known) {
    await crudRepository(db).update(known.id, {
      upstreamGithubRepoId: manualUpstream?.id ?? null,
      upstreamFullName: manualUpstream?.fullName ?? null,
      upstreamDefaultBranch: manualUpstream?.defaultBranch ?? null,
      upstreamStrategy: manualUpstream === null ? null : "manual",
    })
    return known
  }

  /*
    `provenance: "imported"` and a real `github_repo_id`, so provisioning reads it rather than
    trying to create it — the placeholder ids `createPending` writes are negative for that reason.
  */
  return await crudRepository(db).create({
    organizationId,
    githubInstallationId: installation.id,
    githubRepoId: String(repository.id),
    ownerLogin: repository.ownerLogin,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    private: repository.private,
    isFork: repository.parent !== null,
    provenance: "imported",
    upstreamGithubRepoId: repository.parent?.id ?? manualUpstream?.id ?? null,
    upstreamFullName: repository.parent?.fullName ?? manualUpstream?.fullName ?? null,
    upstreamDefaultBranch:
      repository.parent?.defaultBranch ?? manualUpstream?.defaultBranch ?? null,
    upstreamStrategy:
      repository.parent === null ? (manualUpstream === null ? null : "manual") : "github_fork",
  })
}

/**
 * The group a repository's projects live in, creating it if this is the first one.
 *
 * Returns the group's id, or `null` if one could not be made — which is deliberately not an error.
 * A customer creating a project cares about the project; failing the request because its container
 * could not be created would turn a presentation detail into an outage. The project is created
 * ungrouped and can be moved later.
 */
async function ensureRepositoryGroup(
  database: typeof db,
  input: {
    organizationId: string
    productionBranch: string | null
    repositoryId: string
    createdByOauthGrantId: string | null
    regionId: string
  },
): Promise<string | null> {
  try {
    const existing = await database
      .selectFrom("project")
      .select(["id"])
      .where("organizationId", "=", input.organizationId)
      .where("repositoryId", "=", input.repositoryId)
      .where("isGroup", "=", true)
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "asc")
      .executeTakeFirst()

    /*
      The *first* group, not the only one.

      "This new group concept doesn't mean there can only be one group per repository" — so a second
      group is legal and someone may well make one. What must not happen is a new project picking an
      arbitrary group when several exist, so this takes the oldest, deterministically, and a
      customer who wants the other one moves it.
    */
    if (existing !== undefined) return existing.id

    const repository = await database
      .selectFrom("repository")
      .select(["name"])
      .where("id", "=", input.repositoryId)
      .executeTakeFirst()
    if (repository === undefined) return null

    const slug = await allocateProjectSlug(database, input.organizationId, repository.name)
    const created = await database
      .insertInto("project")
      .values({
        id: v7(),
        createdByOauthGrantId: input.createdByOauthGrantId,
        isGroup: true,
        name: repository.name,
        organizationId: input.organizationId,
        // A group has no build target. `.` and the repository's own branch are what the partial
        // unique index excludes groups from, so these are recorded rather than meaningful.
        productionBranch: input.productionBranch ?? "main",
        repositoryId: input.repositoryId,
        regionId: input.regionId,
        rootDir: ".",
        slug,
        state: "ready",
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    return created.id
  } catch (cause) {
    console.error(
      JSON.stringify({
        error: String(cause),
        level: "error",
        message: "could not create the repository's group; the project will be ungrouped",
        repositoryId: input.repositoryId,
      }),
    )
    return null
  }
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/projects",
    describeRoute({
      description: "Lists the organization's projects",
      responses: {
        200: {
          description: "A page of projects",
          content: { "application/json": { schema: resolver(projectSchemaListResponse) } },
        },
        400: { description: "Invalid cursor", ...errorResponse },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: notFoundResponse,
      },
    }),
    validator("param", projectSchemaOrgParam),
    validator("query", projectSchemaListQuery),
    requirePermission("project:read", collectionResource("project", "project")),
    async (c) => {
      const organization = c.var.organization
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null
      const limit = query.limit ?? 25

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const { results, nextCursor } = await cursorPaginate({
        query: fetchProject(db).listInOrganizationQuery(
          organization.id,
          query.repositoryId ?? null,
        ),
        cursor,
        ordering: "id",
        positionColumn: "project.id",
        pageSize: limit,
      })

      return c.json({ data: await enrich(organization.id, results), nextCursor })
    },
  )
  .post(
    "/:orgSlug/projects",
    describeRoute({
      description:
        "Creates a project from a store listing, from scratch, or on a repository the organization already has",
      responses: {
        201: {
          description: "The project and the job that will provision it",
          content: { "application/json": { schema: resolver(projectSchemaCreateResponse) } },
        },
        400: { description: "Invalid source, slug, or missing GitHub account", ...errorResponse },
        403: { description: "Caller lacks project:create", ...errorResponse },
        404: notFoundResponse,
        409: {
          description: "That repository, directory, and branch are already a project",
          ...errorResponse,
        },
      },
    }),
    validator("param", projectSchemaOrgParam),
    validator("json", projectSchemaCreateRequest),
    requirePermission("project:create", collectionResource("project", "project")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const json = c.req.valid("json")
      const source = json.source

      if (source.type !== "store" && (json.templateInputs?.length ?? 0) > 0) {
        return throwBadRequest(
          c,
          "Template inputs are only accepted for a signed store listing",
          ErrorCode.ValidationFailed,
          { target: "templateInputs" },
        )
      }

      const selectedRegion = await db
        .selectFrom("region")
        .select("id")
        .where("code", "=", json.region)
        .where("isActive", "=", true)
        .executeTakeFirst()
      if (selectedRegion === undefined) {
        return throwBadRequest(c, "Region is not available", ErrorCode.ValidationFailed, {
          target: "region",
        })
      }

      if (json.slug !== undefined && !isValidProjectSlug(json.slug)) {
        return throwBadRequest(c, "Slug is malformed", ErrorCode.ValidationFailed, {
          target: "slug",
        })
      }

      const installation = await fetchGithubInstallation(db).listUsable(organization.id, [
        "id",
        "accountLogin",
        "accountType",
      ])
      const defaultInstallation = installation[0]

      /*
        Where a repository goes when nothing says otherwise.

        The caller's own GitHub account, read from `user.github_login`. It used to be the App
        installation or nothing, and "nothing" meant a 400 telling a signed-in user to install a
        GitHub App before they could fork anything — while the platform already knew exactly which
        GitHub account they were, because that is how they signed in.

        Last, not first. An organization that *has* installed the App has said where its
        repositories belong, and a member forking into their personal account instead would be
        putting a team's project somewhere the team cannot administer.

        Null for an account that has never signed in through GitHub — an invited member who has only
        ever used the API. That still produces the 400 below, which is the right answer for them.
      */
      const signedInAs = await fetchUser(db).getOne(user.id, ["githubLogin"])
      const forkDestination =
        defaultInstallation?.accountLogin ?? signedInAs?.githubLogin ?? undefined

      let plan: RepositoryPlan
      let jobKind: ProjectJobKind
      let storeListingId: string | null = null
      let productionBranch = json.productionBranch ?? null
      /*
        Build settings, defaulted from the listing.

        A customer forking Memos has no reason to know that its Dockerfile lives under `docker/`,
        and asking them is asking them to do the one thing the store exists to save them from. The
        listing knows, so the listing supplies it; the request may still override, and the project
        owns the value from then on.
      */
      let listingRootDir: string | null = null
      let listingDockerfilePath: string | null = null
      let templateInstall:
        | Parameters<ReturnType<typeof provisionProject>["create"]>[0]["templateInstall"]
        | undefined = undefined
      let templateProjectId: string | undefined

      if (source.type === "repository") {
        const repository = await resolveOwnRepository(organization.id, source)
        if (repository === undefined) return throwNotFound(c, "Repository not found")

        plan = { id: repository.id, mode: "existing" }
        jobKind = "provision"
        productionBranch ??= repository.defaultBranch
      } else if (source.type === "store") {
        const listing = await fetchStoreListing(db).getOne(source.storeListingId, [
          "id",
          "slug",
          "status",
          "defaultBranch",
          "upstreamOwner",
          "upstreamRepo",
          "rootDir",
          "dockerfilePath",
          "catalogueImportId",
          "catalogueEntryId",
          "templatePluginRepository",
          "templatePluginDigest",
        ])

        if (!listing || listing.status !== "published") {
          return throwBadRequest(
            c,
            "Listing is not available to copy",
            ErrorCode.ResourceNotFound,
            {
              target: "source.storeListingId",
            },
          )
        }

        const ownerLogin = source.ownerLogin ?? forkDestination
        if (ownerLogin === undefined) {
          return throwBadRequest(
            c,
            "No GitHub account to copy into. Sign in with GitHub, install the SproutOS GitHub App, or name the account with source.ownerLogin.",
            ErrorCode.ValidationFailed,
            { target: "source.ownerLogin" },
          )
        }

        storeListingId = listing.id
        const catalogueManifest = await fetchStoreListing(db).getCatalogueManifest(listing.id)
        if (
          listing.catalogueImportId === null ||
          listing.catalogueEntryId === null ||
          catalogueManifest === undefined ||
          listing.templatePluginRepository === null ||
          listing.templatePluginDigest === null
        ) {
          throw new Error("published catalogue listing is missing signed template provenance")
        }
        const catalogueImport = await fetchDeploymentCatalogueImport(db).getOne(
          listing.catalogueImportId,
          ["catalogueDigest", "sourceSha", "provenance"],
        )
        if (catalogueImport === undefined) {
          throw new Error("published catalogue listing points at a missing catalogue import")
        }
        const manifest = parseCatalogueAppManifest(catalogueManifest)
        let resolvedInputs: ReturnType<typeof validateCatalogueUserInputs>
        try {
          resolvedInputs = validateCatalogueUserInputs(
            manifest.user_inputs,
            json.templateInputs ?? [],
          )
        } catch (error) {
          return throwBadRequest(
            c,
            error instanceof Error ? error.message : "Template inputs are invalid",
            ErrorCode.ValidationFailed,
            { target: "templateInputs" },
          )
        }
        const projectIdForTemplate = v7()
        templateProjectId = projectIdForTemplate
        const environmentInputs = await Promise.all(
          resolvedInputs.map(async (input) => ({
            environment: input.environment,
            secret: input.secret,
            value: await sealEnvVarValue(projectIdForTemplate, input.environment, input.value),
          })),
        )
        templateInstall = {
          catalogueImportId: listing.catalogueImportId,
          catalogueEntryId: listing.catalogueEntryId,
          catalogueDigest: catalogueImport.catalogueDigest,
          manifestDigest: manifestDigestForCatalogueEntry(
            catalogueImport.provenance,
            listing.catalogueEntryId,
          ),
          deploymentTemplatesCommit: catalogueImport.sourceSha,
          manifest: catalogueManifest,
          pluginRepository: listing.templatePluginRepository,
          pluginDigest: listing.templatePluginDigest,
          configuredInputs: resolvedInputs.map(({ key, environment, secret }) => ({
            key,
            environment,
            secret,
          })),
          environmentInputs,
        }
        listingRootDir = listing.rootDir
        listingDockerfilePath = listing.dockerfilePath
        jobKind = "provision"
        productionBranch ??= listing.defaultBranch
        plan = {
          defaultBranch: listing.defaultBranch,
          githubInstallationId: defaultInstallation?.id ?? null,
          isFork: false,
          mode: "create",
          name: source.repositoryName ?? listing.slug,
          ownerLogin,
          private: source.private ?? true,
          provenance: "copy",
          upstreamDefaultBranch: listing.defaultBranch,
          upstreamFullName: `${listing.upstreamOwner}/${listing.upstreamRepo}`,
          upstreamStrategy: "snapshot_copy",
        }
      } else {
        const ownerLogin = source.ownerLogin ?? forkDestination
        if (ownerLogin === undefined) {
          return throwBadRequest(
            c,
            "No GitHub account to create the repository in. Sign in with GitHub, install the SproutOS GitHub App, or name the account with source.ownerLogin.",
            ErrorCode.ValidationFailed,
            { target: "source.ownerLogin" },
          )
        }

        const fromTemplate = source.templateOwner !== undefined && source.templateRepo !== undefined

        jobKind = "provision"
        productionBranch ??= "main"
        plan = {
          defaultBranch: productionBranch,
          githubInstallationId: defaultInstallation?.id ?? null,
          isFork: false,
          mode: "create",
          name: source.repositoryName ?? json.name,
          ownerLogin,
          private: source.private ?? true,
          provenance: fromTemplate ? "template" : "new",
          upstreamFullName: fromTemplate ? `${source.templateOwner}/${source.templateRepo}` : null,
          upstreamStrategy: fromTemplate ? "snapshot_copy" : null,
        }
      }

      const rootDir = json.rootDir ?? listingRootDir ?? "."
      const dockerfilePath = json.dockerfilePath ?? listingDockerfilePath ?? "Dockerfile"

      /*
        A repository starts as a group, and the deployable project goes inside it.

        "Start all repositories as groups, and the AI or user via UI can determine creating new
        projects." A repository is the thing a customer connects; what deploys out of it is a
        decision they may make more than once, and a monorepo makes that the normal case rather than
        the exception.

        The group is created *around* the project rather than instead of it. Returning a group from
        "create a project" would mean the store's one-click deploy produced something that deploys
        nothing, and a customer watching for their app would watch forever. So the response is still
        the deployable project — the group is the container it arrives in.

        Only for the first project on a repository, and only when the caller did not decide for
        itself: a second project joins the group that is already there, and an explicit
        `parentProjectId` or `isGroup` is an answer we should not overrule.
      */
      let parentProjectId = json.parentProjectId ?? null
      if (json.isGroup !== true && parentProjectId === null && plan.mode === "existing") {
        /*
          Only where the repository already exists.

          A fork has no `repository` row until provisioning creates one, and a group needs one —
          `project.repository_id` is NOT NULL because a group *is* the repository root. Connecting a
          repository you already have is also the case the requirement is about: a monorepo, with
          more than one deployable in it.
        */
        parentProjectId = await ensureRepositoryGroup(db, {
          organizationId: organization.id,
          productionBranch,
          repositoryId: plan.id,
          createdByOauthGrantId: c.var.auth.kind === "session" ? null : c.var.auth.oauthGrantId,
          regionId: selectedRegion.id,
        })
      }

      if (parentProjectId !== null) {
        const parent = await fetchProject(db).getInOrganization(organization.id, parentProjectId, [
          "id",
          "isGroup",
          "regionId",
          "repositoryId",
        ])
        if (
          parent === undefined ||
          !parent.isGroup ||
          plan.mode !== "existing" ||
          parent.repositoryId !== plan.id
        ) {
          return throwBadRequest(
            c,
            "Group must represent the same repository as this project",
            ErrorCode.ValidationFailed,
            { target: "parentProjectId" },
          )
        }
      }

      // A group builds nothing, so it has no target to conflict over.
      if (plan.mode === "existing" && json.isGroup !== true) {
        const conflict = await fetchProject(db).findConflictingTarget({
          organizationId: organization.id,
          productionBranch,
          repositoryId: plan.id,
          rootDir,
        })

        if (conflict !== undefined) {
          return throwError(
            c,
            409,
            ErrorCode.ResourceAlreadyExists,
            `Project "${conflict.slug}" already builds ${rootDir} on ${productionBranch} in this repository. Use a different directory or branch.`,
            { target: "source.repositoryId" },
          )
        }
      }

      // Auto-update defaults to the credential, not to a product setting. A Claude subscription
      // is flat-rate, so scheduled upkeep costs the customer nothing they are not already paying;
      // any per-token API key would spend real money they never authorized. TASK 17.
      const credential =
        json.agentCredentialId === undefined || json.agentCredentialId === null
          ? await fetchAgentCredential(db).getDefaultForOrganization(organization.id, [
              "id",
              "kind",
            ])
          : await fetchAgentCredential(db).getInOrganization(
              organization.id,
              json.agentCredentialId,
              ["id", "kind"],
            )

      if (
        json.agentCredentialId !== undefined &&
        json.agentCredentialId !== null &&
        credential === undefined
      ) {
        return throwBadRequest(c, "Agent credential not found", ErrorCode.ValidationFailed, {
          target: "agentCredentialId",
        })
      }

      const slug = await allocateProjectSlug(db, organization.id, json.slug ?? json.name)

      const provisioned = await provisionProject(db).create({
        ...(templateProjectId === undefined ? {} : { projectId: templateProjectId }),
        actorUserId: user.id,
        createdByOauthGrantId: c.var.auth.kind === "session" ? null : c.var.auth.oauthGrantId,
        agentCredentialId: credential?.id ?? null,
        audit: auditContext(c),
        autoUpdateEnabled: json.autoUpdateEnabled ?? autoUpdateDefaultFor(credential?.kind),
        autoUpdateCadence: json.autoUpdateCadence ?? "one_week",
        autoUpdateMode: json.autoUpdateMode ?? "suggest",
        syncUpstreamNow: json.syncUpstreamNow,
        idempotencyKey:
          json.idempotencyKey === undefined
            ? null
            : `project:${organization.id}:${json.idempotencyKey}`,
        jobKind,
        kind: json.kind ?? "site",
        name: json.name,
        description: json.description ?? null,
        organizationId: organization.id,
        productionBranch,
        dockerfilePath,
        ...(json.scaleMode === undefined ? {} : { scaleMode: json.scaleMode }),
        repository: plan,
        rootDir,
        slug,
        storeListingId,
        ...(templateInstall === undefined ? {} : { templateInstall }),
        isGroup: json.isGroup ?? false,
        parentProjectId,
        regionId: selectedRegion.id,
      })

      /*
        Hand the job to the worker.

        The `project_job` row is the customer-visible progress record; this is what makes something
        happen. Until this line existed, `POST /projects` wrote a project, a repository with no
        `github_repo_id`, and four `pending` steps that nothing would ever move — a fork that
        returned 201 and created nothing on GitHub, forever.

        Keyed on the `project_job` id, so a duplicate enqueue collides rather than forking twice.
      */
      /*
        A group is not provisioned.

        There is no repository to fork, nothing to build, and no function to publish — the row *is*
        the whole object. Enqueuing the job anyway would run a fork against a repository that
        already exists and then mark a first deploy that has no artifact, which is the exact failure
        `provision.ts` produces today for anything with no build.
      */
      if (json.isGroup !== true) {
        await enqueue(db, {
          kind: JOB_KINDS.provisionProject,
          idempotencyKey: `${JOB_KINDS.provisionProject}:${provisioned.job.id}`,
          payload: { projectJobId: provisioned.job.id, userId: user.id },
          // Three, not the default. The failures here are GitHub's 5xx and secondary rate limits,
          // which pass; a missing scope fails on the first attempt and would fail identically on the
          // tenth, so a larger number would only delay the error a customer needs to see.
          maxAttempts: 3,
        })
      }

      /*
        Ask GitHub whether the App is already installed on the account this repository will live on.

        Nothing else would. `github.installation.sync` drops an installation on an account no
        organization owns yet, and creating a project is not a GitHub event, so no delivery ever
        arrives to reconsider it — installing the App before creating the first project left it
        permanently invisible, and this route is the moment that stops being true.

        Keyed on this project operation as well as the App identity and login. A retry of this
        create deduplicates, while a later project creation rechecks a newly installed App or a
        webhook that never arrived.
      */
      if (plan.mode === "create") {
        await enqueue(db, {
          kind: GITHUB_EVENT_KINDS.installationDiscover,
          idempotencyKey: installationDiscoveryIdempotencyKey({
            appId: process.env.GITHUB_APP_ID,
            login: plan.ownerLogin,
            operationId: provisioned.project.id,
            organizationId: organization.id,
          }),
          payload: { login: plan.ownerLogin, organizationId: organization.id },
          maxAttempts: 3,
        })
      }

      /*
        The attempt, not the install.

        `install_count` was incremented here, three lines after the job was queued and long before
        anything had been forked. It is the number on every store card labelled "INSTALLS", and it
        counted attempts: two failed forks of the same listing — both of which ended in
        `NoUsableCredentialError` and left no repository anywhere — read as two installs. The
        counter is now moved by `runProvision` when the fork actually succeeds.

        The event stays here, because `fork_started` is exactly what this is, and its counterpart
        `fork_completed` has been in the table's check constraint since the first migration with
        nothing ever writing it.
      */
      if (storeListingId !== null) {
        await crudStoreListingEvent(db).record({
          kind: "fork_started",
          storeListingId,
          userId: user.id,
        })
      }

      return c.json(
        {
          job: serializeJob(provisioned.job),
          project: await serializeOneProject(
            organization.id,
            provisioned.project,
            provisioned.repository,
          ),
        },
        201,
      )
    },
  )
  .get(
    "/:orgSlug/projects/:projectId",
    describeRoute({
      description: "Reads one project with its repository and counters",
      responses: {
        200: {
          description: "The project",
          content: { "application/json": { schema: resolver(projectSchemaResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, [
        ...PROJECT_FIELDS,
      ])
      if (!project) return throwNotFound(c, "Project not found")

      const repository = await fetchRepository(db).getInOrganization(
        organization.id,
        project.repositoryId,
        [
          "id",
          "githubRepoId",
          "ownerLogin",
          "name",
          "defaultBranch",
          "private",
          "isFork",
          "provenance",
          "upstreamFullName",
          "upstreamStrategy",
          "githubInstallationId",
        ],
      )
      if (!repository) return throwNotFound(c, "Project not found")

      const [liveProjectCount, pendingUpdateSuggestions, envVarCount] = await Promise.all([
        fetchRepository(db).countLiveProjects(repository.id),
        fetchProjectUpdateSuggestion(db).countPending(project.id),
        fetchProjectEnvVar(db).countForProject(project.id),
      ])

      const pendingCreation = isPendingGithubRepoId(repository.githubRepoId)

      return c.json({
        ...(await serializeOneProject(c.var.organization.id, project, repository)),
        envVarCount,
        pendingUpdateSuggestions,
        repository: {
          defaultBranch: repository.defaultBranch,
          githubInstallationId: repository.githubInstallationId,
          githubRepoId: pendingCreation ? null : repository.githubRepoId,
          id: repository.id,
          isFork: repository.isFork,
          liveProjectCount,
          name: repository.name,
          ownerLogin: repository.ownerLogin,
          pendingCreation,
          private: repository.private,
          provenance: repository.provenance,
          upstreamFullName: repository.upstreamFullName,
          upstreamStrategy: repository.upstreamStrategy,
        },
      })
    },
  )
  .patch(
    "/:orgSlug/projects/:projectId",
    describeRoute({
      description: "Updates a project's settings",
      responses: {
        200: {
          description: "The updated project",
          content: { "application/json": { schema: resolver(projectSchemaEntryResponse) } },
        },
        400: { description: "Invalid slug or credential", ...errorResponse },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
        409: {
          description: "That directory and branch are already another project",
          ...errorResponse,
        },
      },
    }),
    validator("param", projectSchemaIdParam),
    validator("json", projectSchemaUpdateRequest),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")
      const json = c.req.valid("json")

      const before = await fetchProject(db).getInOrganization(organization.id, projectId, [
        ...PROJECT_FIELDS,
      ])
      if (!before) return throwNotFound(c, "Project not found")

      if (json.slug !== undefined && json.slug !== before.slug) {
        if (!isValidProjectSlug(json.slug)) {
          return throwBadRequest(c, "Slug is malformed", ErrorCode.ValidationFailed, {
            target: "slug",
          })
        }

        const taken = await fetchProject(db).getBySlug(organization.id, json.slug, ["id"])
        if (taken !== undefined) {
          return throwBadRequest(c, "Slug is already taken", ErrorCode.ResourceAlreadyExists, {
            target: "slug",
          })
        }
      }

      const rootDir = json.rootDir ?? before.rootDir
      const productionBranch = json.productionBranch ?? before.productionBranch

      if (rootDir !== before.rootDir || productionBranch !== before.productionBranch) {
        const conflict = await fetchProject(db).findConflictingTarget({
          organizationId: organization.id,
          productionBranch,
          repositoryId: before.repositoryId,
          rootDir,
        })

        if (conflict !== undefined && conflict.id !== projectId) {
          return throwError(
            c,
            409,
            ErrorCode.ResourceAlreadyExists,
            `Project "${conflict.slug}" already builds ${rootDir} on ${productionBranch} in this repository.`,
          )
        }
      }

      if (json.agentCredentialId !== undefined && json.agentCredentialId !== null) {
        const credential = await fetchAgentCredential(db).getInOrganization(
          organization.id,
          json.agentCredentialId,
          ["id"],
        )
        if (!credential) {
          return throwBadRequest(c, "Agent credential not found", ErrorCode.ValidationFailed, {
            target: "agentCredentialId",
          })
        }
      }

      const selectedRegion =
        json.region === undefined
          ? undefined
          : await db
              .selectFrom("region")
              .select("id")
              .where("code", "=", json.region)
              .where("isActive", "=", true)
              .executeTakeFirst()
      if (json.region !== undefined && selectedRegion === undefined) {
        return throwBadRequest(c, "Region is not available", ErrorCode.ValidationFailed, {
          target: "region",
        })
      }

      if (json.primaryChildProjectId !== undefined) {
        if (!before.isGroup) {
          return throwBadRequest(
            c,
            "Only a group can have a primary project",
            ErrorCode.ValidationFailed,
            { target: "primaryChildProjectId" },
          )
        }
        if (json.primaryChildProjectId !== null) {
          const primary = await fetchProject(db).getInOrganization(
            organization.id,
            json.primaryChildProjectId,
            ["id", "isGroup", "parentProjectId"],
          )
          if (primary === undefined || primary.isGroup || primary.parentProjectId !== projectId) {
            return throwBadRequest(
              c,
              "Primary project must be a deployable child of this group",
              ErrorCode.ValidationFailed,
              { target: "primaryChildProjectId" },
            )
          }
        }
      }

      if (before.isGroup && json.isGroup === false) {
        const children = await fetchProject(db).listChildren(organization.id, projectId, ["id"])
        if (children.length > 0) {
          return throwBadRequest(
            c,
            "Move every child out of this group before making it deployable",
            ErrorCode.ValidationFailed,
            { target: "isGroup" },
          )
        }
      }

      /*
        Converting to a group is refused once anything has served.

        A group deploys nothing, so flipping a live project would take its site down with no
        deployment event to explain it — the hostname would simply stop being republished. A project
        that has only ever failed to deploy has nothing to lose, which is the common case for one
        being reorganised.
      */
      if (json.isGroup === true) {
        const serving = await db
          .selectFrom("deployment")
          .select("id")
          .where("projectId", "=", projectId)
          .where("status", "=", "ready")
          .where("deletedAt", "is", null)
          .executeTakeFirst()

        if (serving !== undefined) {
          return throwBadRequest(
            c,
            "This project has deployed, so it cannot become a group — a group serves no traffic " +
              "and converting it would take the site down. Create a group and move its projects " +
              "into it instead.",
            ErrorCode.ValidationFailed,
            { target: "isGroup" },
          )
        }
      }

      /*
        A group cannot itself sit inside a group, for now.

        One level is what the switcher renders and what the requirement describes. Nesting is not
        forbidden by the schema — `parent_project_id` is a plain self-reference — so this is the only
        thing stopping a tree, and it is here rather than in the database because the restriction is
        a product decision that may well be relaxed.
      */
      if (
        json.isGroup === true &&
        json.parentProjectId !== undefined &&
        json.parentProjectId !== null
      ) {
        return throwBadRequest(
          c,
          "A group cannot be placed inside another group.",
          ErrorCode.ValidationFailed,
          { target: "parentProjectId" },
        )
      }

      /*
        A parent must exist, be a group, and not be the project itself.

        Checked here rather than left to the foreign key, which only knows the row exists. A project
        parented to a *deployable* project would render as a child in the switcher under something
        that also deploys, and a project parented to itself makes the tree infinite — neither is
        expressible as a constraint the database could have caught.
      */
      if (json.parentProjectId !== undefined && json.parentProjectId !== null) {
        if (json.parentProjectId === projectId) {
          return throwBadRequest(
            c,
            "A project cannot be its own group",
            ErrorCode.ValidationFailed,
            {
              target: "parentProjectId",
            },
          )
        }

        const parent = await fetchProject(db).getInOrganization(
          organization.id,
          json.parentProjectId,
          ["id", "isGroup"],
        )
        if (parent === undefined) {
          return throwBadRequest(c, "Group not found", ErrorCode.ValidationFailed, {
            target: "parentProjectId",
          })
        }
        if (!parent.isGroup) {
          return throwBadRequest(
            c,
            "That project is not a group. Only a group can hold other projects.",
            ErrorCode.ValidationFailed,
            { target: "parentProjectId" },
          )
        }
      }

      const updated = await db.transaction().execute(async (tx) => {
        const row = await crudProject(tx).update(organization.id, projectId, {
          ...(json.name === undefined ? {} : { name: json.name }),
          ...(json.description === undefined ? {} : { description: json.description }),
          ...(json.region === undefined ? {} : { regionId: selectedRegion?.id }),
          ...(json.slug === undefined ? {} : { slug: json.slug }),
          ...(json.rootDir === undefined ? {} : { rootDir: json.rootDir }),
          ...(json.dockerfilePath === undefined ? {} : { dockerfilePath: json.dockerfilePath }),
          ...(json.productionBranch === undefined
            ? {}
            : { productionBranch: json.productionBranch }),
          ...(json.agentCredentialId === undefined
            ? {}
            : { agentCredentialId: json.agentCredentialId }),
          ...(json.autoUpdateEnabled === undefined
            ? {}
            : { autoUpdateEnabled: json.autoUpdateEnabled }),
          ...(json.autoUpdateCadence === undefined
            ? {}
            : { autoUpdateCadence: json.autoUpdateCadence }),
          ...(json.autoUpdateMode === undefined ? {} : { autoUpdateMode: json.autoUpdateMode }),
          ...(json.scaleMode === undefined ? {} : { scaleMode: json.scaleMode }),
          ...(json.parentProjectId === undefined ? {} : { parentProjectId: json.parentProjectId }),
          ...(json.isGroup === undefined ? {} : { isGroup: json.isGroup }),
          ...(json.primaryChildProjectId === undefined
            ? {}
            : { primaryChildProjectId: json.primaryChildProjectId }),
          ...(json.isGroup === false ? { primaryChildProjectId: null } : {}),
        })

        if (row === undefined) return undefined

        await crudAuditLog(tx).record({
          action: "project:update",
          actorUserId: user.id,
          after: {
            autoUpdateEnabled: row.autoUpdateEnabled,
            autoUpdateCadence: row.autoUpdateCadence,
            autoUpdateMode: row.autoUpdateMode,
            name: row.name,
            productionBranch: row.productionBranch,
            rootDir: row.rootDir,
            slug: row.slug,
          },
          before: {
            autoUpdateEnabled: before.autoUpdateEnabled,
            autoUpdateCadence: before.autoUpdateCadence,
            autoUpdateMode: before.autoUpdateMode,
            name: before.name,
            productionBranch: before.productionBranch,
            rootDir: before.rootDir,
            slug: before.slug,
          },
          organizationId: organization.id,
          resourceSrn: srnFor("project", organization.id, "project", projectId),
          ...auditContext(c),
        })

        return row
      })

      if (updated === undefined) return throwNotFound(c, "Project not found")

      const repository = await fetchRepository(db).getInOrganization(
        organization.id,
        updated.repositoryId,
        ["ownerLogin", "name", "provenance"],
      )

      return c.json(
        await serializeOneProject(
          c.var.organization.id,
          updated,
          repository ?? { name: "", ownerLogin: "", provenance: "new" },
        ),
      )
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId",
    describeRoute({
      description: "Soft-deletes a project and queues its teardown",
      responses: {
        200: {
          description: "What was destroyed, what was scheduled, and what was kept",
          content: { "application/json": { schema: resolver(projectSchemaDeleteResponse) } },
        },
        403: { description: "Caller lacks project:delete", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    requirePermission("project:delete", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const deleting = await fetchProject(db).getInOrganization(organization.id, projectId, [
        "id",
        "isGroup",
      ])
      if (deleting === undefined) return throwNotFound(c, "Project not found")

      const deleted = await db.transaction().execute(async (tx) => {
        const childResults = []
        if (deleting.isGroup) {
          const descendants = await listDescendantsDeepestFirst(tx, organization.id, projectId)
          for (const descendant of descendants) {
            const removed = await provisionProject(tx).removeInTransaction(tx, {
              actorUserId: user.id,
              audit: auditContext(c),
              organizationId: organization.id,
              projectId: descendant.id,
              preserveEmptyGroups: true,
            })
            if (removed !== null) childResults.push(removed)
          }
        }

        const result = await provisionProject(tx).removeInTransaction(tx, {
          actorUserId: user.id,
          audit: auditContext(c),
          organizationId: organization.id,
          projectId,
          preserveEmptyGroups: deleting.isGroup,
        })

        if (result === null) return null

        for (const removed of [...childResults, result]) {
          await enqueue(tx, {
            kind: JOB_KINDS.tearDownProject,
            idempotencyKey: `${JOB_KINDS.tearDownProject}:${removed.project.id}:${removed.job.id}`,
            payload: { projectId: removed.project.id, projectJobId: removed.job.id },
            maxAttempts: 5,
          })
        }

        return { childResults, result }
      })

      if (deleted === null) return throwNotFound(c, "Project not found")
      const { childResults, result } = deleted

      /*
        The teardown this route has always claimed to queue.

        The description says "queues its teardown", the message below says "a teardown job is
        queued", and `scheduledForTeardown` names nine kinds of resource. Nothing was enqueued:
        `provisionProject.remove` wrote a `project_job` of kind `delete` that no handler knew, and
        `JOB_KINDS` had no teardown at all. A deleted project's Knative service went on serving
        traffic and billing, its sandbox went on holding a node, and its backend services stayed
        provisioned with live credentials.

        Keyed on the immutable deletion progress row. A retry of this database transaction
        collides safely, while a later cleanup adoption gets a fresh key instead of being absorbed
        by an old terminal job for the same project.
      */
      const repositoryNote = result.repositoryReleased
        ? "The repository was released with it."
        : `The repository is still used by ${result.remainingProjectsOnRepository} other project(s) and was kept.`

      return c.json({
        destroyed: [],
        job: serializeJob(result.job),
        jobs: [...childResults.map((child) => serializeJob(child.job)), serializeJob(result.job)],
        message:
          `${deleting.isGroup ? `Group and ${childResults.length} descendant project(s)` : `Project "${result.project.slug}"`} are marked deleted and teardown jobs are queued deepest-first. ` +
          `Nothing has been destroyed yet, and billing history is never destroyed — ` +
          `usage events, rollups, statement line items, and audit rows still reference it. ` +
          repositoryNote,
        project: {
          deletedAt: result.project.deletedAt?.toISOString() ?? null,
          id: result.project.id,
          slug: result.project.slug,
          state: result.project.state,
        },
        remainingProjectsOnRepository: result.remainingProjectsOnRepository,
        repositoryReleased: result.repositoryReleased,
        retained: [...RETAINED_ON_DELETE],
        scheduledForTeardown: [...TORN_DOWN_BY_JOB],
      })
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/jobs",
    describeRoute({
      description: "Lists the recent provisioning jobs for a project",
      responses: {
        200: {
          description: "Jobs, most recent first",
          content: { "application/json": { schema: resolver(projectSchemaJobListResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const jobs = await fetchProjectJob(db).listForProject(organization.id, projectId, [
        ...JOB_FIELDS,
      ])

      return c.json({ data: jobs.map((job) => serializeJob(job)) })
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/jobs/:jobId",
    describeRoute({
      description: "Polls one provisioning job",
      responses: {
        200: {
          description: "The job's current state and steps",
          content: { "application/json": { schema: resolver(projectSchemaJobResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such job for this project", ...errorResponse },
      },
    }),
    validator("param", projectSchemaJobParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { jobId, projectId } = c.req.valid("param")

      const job = await fetchProjectJob(db).getInOrganization(organization.id, jobId, [
        ...JOB_FIELDS,
        "projectId",
      ])

      if (!job || job.projectId !== projectId) return throwNotFound(c, "Job not found")

      return c.json(serializeJob(job))
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/jobs/:jobId/cancel",
    describeRoute({
      description: "Cancels a queued or running agent-assisted upstream resolution",
      responses: {
        200: {
          description: "The canceled job",
          content: { "application/json": { schema: resolver(projectSchemaJobResponse) } },
        },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "No such cancellable job for this project", ...errorResponse },
      },
    }),
    validator("param", projectSchemaJobParam),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const user = c.var.user
      const { jobId, projectId } = c.req.valid("param")
      const canceled = await db.transaction().execute(async (tx) => {
        const prior = await tx
          .selectFrom("projectJob")
          .select("state")
          .where("id", "=", jobId)
          .where("organizationId", "=", organization.id)
          .where("projectId", "=", projectId)
          .where("kind", "=", "sync_upstream")
          .where("state", "in", ["queued", "running"])
          .forUpdate()
          .executeTakeFirst()
        if (prior === undefined) return undefined
        const job = await tx
          .updateTable("projectJob")
          .set({ state: "canceled", finishedAt: new Date(), updatedAt: new Date() })
          .where("id", "=", jobId)
          .where("organizationId", "=", organization.id)
          .where("projectId", "=", projectId)
          .where("kind", "=", "sync_upstream")
          .where("state", "in", ["queued", "running"])
          .returningAll()
          .executeTakeFirst()
        if (job === undefined) return undefined
        const details =
          typeof job.details === "object" && job.details !== null
            ? (job.details as Record<string, unknown>)
            : {}
        if (typeof details.upstreamSyncRunId === "string") {
          await tx
            .updateTable("backgroundJob")
            .set({
              state: "cancelled",
              finishedAt: new Date(),
              leaseExpiresAt: null,
              lockedBy: null,
              updatedAt: new Date(),
            })
            .where(
              "idempotencyKey",
              "=",
              `${JOB_KINDS.upkeepResolveConflict}:${details.upstreamSyncRunId}`,
            )
            .where("state", "in", ["queued", "leased", "running"])
            .execute()
        }
        if (typeof details.agentSessionId === "string") {
          await crudAgentSession(tx).setStatus(details.agentSessionId, "archived")
        }
        await crudAuditLog(tx).record({
          action: "project:update",
          actorUserId: user.id,
          after: { state: "canceled" },
          before: { state: prior.state },
          organizationId: organization.id,
          resourceSrn: srnFor("project", organization.id, "job", job.id),
          ...auditContext(c),
        })
        return job
      })
      if (canceled === undefined) return throwNotFound(c, "Cancellable job not found")
      return c.json(serializeJob(canceled))
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/env",
    describeRoute({
      description: "Lists a project's environment variables. Values are never included.",
      responses: {
        200: {
          description: "Variable names and metadata, without values",
          content: { "application/json": { schema: resolver(projectSchemaEnvVarListResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const rows = await fetchProjectEnvVar(db).listForProject(project.id)

      return c.json({
        data: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      })
    },
  )
  .put(
    "/:orgSlug/projects/:projectId/env",
    describeRoute({
      description: "Sets one environment variable. The value is envelope-encrypted before storage.",
      responses: {
        200: {
          description: "The stored variable, without its value",
          content: { "application/json": { schema: resolver(projectSchemaEnvVarResponse) } },
        },
        403: { description: "Caller lacks credential:write", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    validator("json", projectSchemaEnvVarRequest),
    requirePermission("credential:write", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")
      const json = c.req.valid("json")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const sealed = await sealEnvVarValue(project.id, json.key, json.value)

      const row = await crudProjectEnvVar(db).upsert({
        isSecret: json.isSecret ?? true,
        key: json.key,
        projectId: project.id,
        target: json.target ?? "all",
        value: sealed,
      })

      // The audit row names the variable and never its value. `before`/`after` land in `jsonb` on
      // an append-only table, so a value written here would be a plaintext secret that literally
      // cannot be deleted.
      await crudAuditLog(db).record({
        action: "credential:write",
        actorUserId: user.id,
        after: { isSecret: row.isSecret, key: row.key, target: row.target },
        before: null,
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "env_var", row.id),
        ...auditContext(c),
      })

      return c.json({
        createdAt: row.createdAt.toISOString(),
        id: row.id,
        isSecret: row.isSecret,
        key: row.key,
        target: row.target,
        updatedAt: row.updatedAt.toISOString(),
        valueKmsKeyId: row.valueKmsKeyId,
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/env/:envVarId/reveal",
    describeRoute({
      description: "Decrypts and returns one variable's value. Audited.",
      responses: {
        200: {
          description: "The plaintext value",
          content: { "application/json": { schema: resolver(projectSchemaEnvVarRevealResponse) } },
        },
        403: { description: "Caller lacks credential:read", ...errorResponse },
        404: { description: "No such variable on this project", ...errorResponse },
        500: { description: "The value could not be decrypted", ...errorResponse },
      },
    }),
    validator("param", projectSchemaEnvVarParam),
    requirePermission("credential:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { envVarId, projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const row = await fetchProjectEnvVar(db).getSealed(project.id, envVarId)
      if (!row) return throwNotFound(c, "Environment variable not found")

      let value: string
      try {
        value = await openEnvVarValue(project.id, row.key, {
          ciphertext: row.valueCiphertext,
          kmsKeyId: row.valueKmsKeyId,
          wrappedDek: row.valueWrappedDek,
        })
      } catch {
        return throwError(
          c,
          500,
          ErrorCode.OperationFailed,
          "This value could not be decrypted. It may have been sealed under a key that is no longer available.",
        )
      }

      // Written after the decrypt succeeds and before the response is built. A reveal that is not
      // in `audit_log` is a secret read that nobody can account for later.
      await crudAuditLog(db).record({
        action: "credential:read",
        actorUserId: user.id,
        after: { key: row.key, revealed: true, target: row.target },
        before: null,
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "env_var", row.id),
        ...auditContext(c),
      })

      return c.json({ id: row.id, key: row.key, target: row.target, value })
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/env/:envVarId",
    describeRoute({
      description: "Removes one environment variable",
      responses: {
        200: {
          description: "Variable removed",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks credential:write", ...errorResponse },
        404: { description: "No such variable on this project", ...errorResponse },
      },
    }),
    validator("param", projectSchemaEnvVarParam),
    requirePermission("credential:write", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { envVarId, projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const row = await fetchProjectEnvVar(db).getMetadata(project.id, envVarId)
      if (!row) return throwNotFound(c, "Environment variable not found")

      await crudProjectEnvVar(db).remove(project.id, envVarId)

      await crudAuditLog(db).record({
        action: "credential:write",
        actorUserId: user.id,
        after: { deleted: true },
        before: { key: row.key, target: row.target },
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "env_var", row.id),
        ...auditContext(c),
      })

      return c.json({})
    },
  )
  /*
    Config files.

    Mirrors `/env` deliberately — same four verbs, same permissions, same audit shape, same `target`
    semantics. They are the same idea delivered through a different mechanism, and a customer who
    has understood one should not have to learn the other.

    It exists because `glance`, a real store listing this platform forked and built, exited with
    `reading /app/config/glance.yml: no such file or directory`. Most self-hostable software is
    configured by a file and reads nothing from the environment.
  */
  .get(
    "/:orgSlug/projects/:projectId/files",
    describeRoute({
      description: "Lists a project's config files. Contents are never included.",
      responses: {
        200: {
          description: "File paths and metadata, without contents",
          content: { "application/json": { schema: resolver(projectSchemaFileListResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const rows = await fetchProjectFile(db).listForProject(project.id)

      return c.json({
        data: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      })
    },
  )
  .put(
    "/:orgSlug/projects/:projectId/files",
    describeRoute({
      description:
        "Writes one config file, mounted at its path in the container. Contents are envelope-encrypted before storage.",
      responses: {
        200: {
          description: "The stored file, without its contents",
          content: { "application/json": { schema: resolver(projectSchemaFileResponse) } },
        },
        403: { description: "Caller lacks credential:write", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    validator("json", projectSchemaFileRequest),
    requirePermission("credential:write", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")
      const json = c.req.valid("json")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const sealed = await sealProjectFileContents(project.id, json.path, json.contents)

      const row = await crudProjectFile(db).upsert({
        contents: sealed,
        // Sealed regardless; this records how to *display* it. A config file is a mixture by
        // nature — layout next to API keys — and asking a customer to classify the whole file is
        // asking them to get it wrong in the direction that costs something.
        isSecret: json.isSecret ?? true,
        path: json.path,
        projectId: project.id,
        target: json.target ?? "all",
      })

      // The audit row names the file and never its contents. `before`/`after` land in `jsonb` on an
      // append-only table, so contents written here would be a plaintext secret that literally
      // cannot be deleted.
      await crudAuditLog(db).record({
        action: "credential:write",
        actorUserId: user.id,
        after: { isSecret: row.isSecret, path: row.path, target: row.target },
        before: null,
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "file", row.id),
        ...auditContext(c),
      })

      return c.json({
        createdAt: row.createdAt.toISOString(),
        id: row.id,
        isSecret: row.isSecret,
        path: row.path,
        target: row.target,
        updatedAt: row.updatedAt.toISOString(),
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/files/:fileId/reveal",
    describeRoute({
      description: "Returns one config file's decrypted contents. Written to the audit log.",
      responses: {
        200: {
          description: "The file's contents",
          content: { "application/json": { schema: resolver(projectSchemaFileRevealResponse) } },
        },
        403: { description: "Caller lacks credential:read", ...errorResponse },
        404: { description: "No such file on this project", ...errorResponse },
      },
    }),
    validator("param", projectSchemaFileParam),
    requirePermission("credential:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { fileId, projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const row = await fetchProjectFile(db).getSealed(project.id, fileId)
      if (!row) return throwNotFound(c, "File not found")

      let contents: string
      try {
        contents = await openProjectFileContents(project.id, row.path, {
          ciphertext: row.contentsCiphertext,
          kmsKeyId: row.contentsKmsKeyId,
          wrappedDek: row.contentsWrappedDek,
        })
      } catch {
        return throwError(
          c,
          500,
          ErrorCode.OperationFailed,
          "These contents could not be decrypted. They may have been sealed under a key that is no longer available.",
        )
      }

      // Written after the decrypt succeeds and before the response is built. A reveal that is not
      // in `audit_log` is a secret read that nobody can account for later.
      await crudAuditLog(db).record({
        action: "credential:read",
        actorUserId: user.id,
        after: { path: row.path, revealed: true, target: row.target },
        before: null,
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "file", row.id),
        ...auditContext(c),
      })

      return c.json({ contents, id: row.id, path: row.path, target: row.target })
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/files/:fileId",
    describeRoute({
      description: "Removes one config file",
      responses: {
        200: {
          description: "File removed",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks credential:write", ...errorResponse },
        404: { description: "No such file on this project", ...errorResponse },
      },
    }),
    validator("param", projectSchemaFileParam),
    requirePermission("credential:write", paramResource("project", "project", "projectId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { fileId, projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const row = await fetchProjectFile(db).getMetadata(project.id, fileId)
      if (!row) return throwNotFound(c, "File not found")

      await crudProjectFile(db).remove(project.id, fileId)

      await crudAuditLog(db).record({
        action: "credential:write",
        actorUserId: user.id,
        after: { deleted: true },
        before: { path: row.path, target: row.target },
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "file", row.id),
        ...auditContext(c),
      })

      return c.json({})
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/update-suggestions",
    describeRoute({
      description: "Lists upstream update suggestions for a forked project",
      responses: {
        200: {
          description: "A page of suggestions",
          content: {
            "application/json": { schema: resolver(projectSchemaSuggestionListResponse) },
          },
        },
        400: { description: "Invalid cursor", ...errorResponse },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    validator("param", projectSchemaIdParam),
    validator("query", projectSchemaSuggestionListQuery),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const { results, nextCursor } = await cursorPaginate({
        query: fetchProjectUpdateSuggestion(db).listForProjectQuery(
          project.id,
          query.status ?? null,
        ),
        cursor,
        ordering: "id",
        positionColumn: "projectUpdateSuggestion.id",
        pageSize: query.limit ?? 25,
      })

      return c.json({
        data: results.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
        })),
        nextCursor,
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/update-suggestions/:suggestionId/accept",
    describeRoute({
      description: "Accepts an upstream update suggestion and queues the sync",
      responses: {
        200: {
          description: "The resolved suggestion",
          content: { "application/json": { schema: resolver(projectSchemaSuggestionResponse) } },
        },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "No such pending suggestion", ...errorResponse },
      },
    }),
    validator("param", projectSchemaSuggestionParam),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      return await resolveSuggestion(c, "accepted")
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/update-suggestions/:suggestionId/dismiss",
    describeRoute({
      description: "Dismisses an upstream update suggestion",
      responses: {
        200: {
          description: "The resolved suggestion",
          content: { "application/json": { schema: resolver(projectSchemaSuggestionResponse) } },
        },
        403: { description: "Caller lacks project:update", ...errorResponse },
        404: { description: "No such pending suggestion", ...errorResponse },
      },
    }),
    validator("param", projectSchemaSuggestionParam),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    async (c) => {
      return await resolveSuggestion(c, "dismissed")
    },
  )
  .get(
    "/:orgSlug/repositories",
    describeRoute({
      description: "Lists the repositories the organization has connected",
      responses: {
        200: {
          description: "A page of repositories",
          content: { "application/json": { schema: resolver(repositorySchemaListResponse) } },
        },
        400: { description: "Invalid cursor", ...errorResponse },
        403: { description: "Caller lacks repository:read", ...errorResponse },
        404: notFoundResponse,
      },
    }),
    validator("param", projectSchemaOrgParam),
    validator("query", repositorySchemaListQuery),
    requirePermission("repository:read", collectionResource("repository", "repository")),
    async (c) => {
      const organization = c.var.organization
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const { results, nextCursor } = await cursorPaginate({
        query: fetchRepository(db).listInOrganizationQuery(organization.id),
        cursor,
        ordering: "id",
        positionColumn: "repository.id",
        pageSize: query.limit ?? 25,
      })

      return c.json({
        data: results.map((row) => {
          const pendingCreation = isPendingGithubRepoId(row.githubRepoId)
          return {
            ...row,
            createdAt: row.createdAt.toISOString(),
            githubRepoId: pendingCreation ? null : row.githubRepoId,
            pendingCreation,
          }
        }),
        nextCursor,
      })
    },
  )

export default app
