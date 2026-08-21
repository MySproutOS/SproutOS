import { JOB_KINDS, enqueue } from "@lib/jobs"
import {
  allocateProjectSlug,
  autoUpdateDefaultFor,
  crudAuditLog,
  crudProject,
  crudProjectEnvVar,
  crudProjectJob,
  crudProjectUpdateSuggestion,
  crudStoreListingEvent,
  fetchAgentCredential,
  fetchGithubInstallation,
  fetchProject,
  fetchProjectEnvVar,
  fetchProjectJob,
  fetchProjectUpdateSuggestion,
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
import { rateProjectsForOrganization, startOfMonth } from "@lib/billing/usage"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import type { DB } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import type { Selectable } from "kysely"
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
import { openEnvVarValue, sealEnvVarValue } from "./project-env"
import {
  projectSchemaCreateRequest,
  projectSchemaCreateResponse,
  projectSchemaDeleteResponse,
  projectSchemaEnvVarListResponse,
  projectSchemaEnvVarParam,
  projectSchemaEnvVarRequest,
  projectSchemaEnvVarResponse,
  projectSchemaEntryResponse,
  projectSchemaEnvVarRevealResponse,
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
  createdAt: Date
  updatedAt: Date
}

/**
 * Adds what the project list actually shows: what it has cost, where it runs, and whether its
 * upstream has moved.
 *
 * Three lookups for the whole page rather than three per project. A dashboard with thirty projects
 * would otherwise make ninety round trips to render one screen, and none of the three needs to know
 * about any single project to answer for all of them.
 */
async function enrich<T extends ProjectRow>(organizationId: string, rows: readonly T[]) {
  if (rows.length === 0) return []
  const projectIds = rows.map((row) => row.id)

  const [rated, regions, behind] = await Promise.all([
    /*
      Rated at read time against the price book in force, never stored. A stored cost is wrong the
      moment a rate changes, and wrong in a way nobody can reconstruct.

      A deployment with no price book seeded is a seeding bug that would otherwise show every
      customer a free product; `rateProjectsForOrganization` throws, and this lets it.
    */
    rateProjectsForOrganization(db, organizationId, startOfMonth()),

    /*
      Region comes from the project's backend services, because a project has no region of its own —
      it is where its *data* lives that a customer cares about, and that is a property of the
      database or queue rather than of the repository.
    */
    db
      .selectFrom("backendService")
      .innerJoin("region", "region.id", "backendService.regionId")
      .select(["backendService.projectId as projectId", "region.code as code"])
      .where("backendService.projectId", "in", projectIds)
      .where("backendService.deletedAt", "is", null)
      .orderBy("backendService.createdAt", "asc")
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
  ])

  // First region wins, matching the `order by created_at` above: a project's first service is the
  // one it was provisioned in, and a later one in another region does not move the project.
  const regionByProject = new Map<string, string>()
  for (const row of regions) {
    if (row.projectId !== null && !regionByProject.has(row.projectId)) {
      regionByProject.set(row.projectId, row.code)
    }
  }
  const behindByRepository = new Map(behind.map((row) => [row.repositoryId, row.behindBy]))

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Absent from the rating map means no metered usage, which is genuinely zero rather than
    // unknown — nothing has been recorded against this project.
    costMicroUsd: (rated.get(row.id)?.total ?? 0n).toString(),
    region: regionByProject.get(row.id) ?? null,
    hasUpstreamUpdate: (behindByRepository.get(row.repositoryId) ?? 0) > 0,
  }))
}

const PROJECT_FIELDS = [
  "id",
  "name",
  "slug",
  "kind",
  "state",
  "stateReason",
  "rootDir",
  "dockerfilePath",
  "productionBranch",
  "autoUpdateEnabled",
  "autoUpdateMode",
  "repositoryId",
  "storeListingId",
  "agentCredentialId",
  "createdAt",
  "updatedAt",
] as const

const JOB_FIELDS = [
  "id",
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
 * destroyed by the request. ADR 0017: `usage_event`, `usage_rollup`, and `statement_line_item`
 * all reference `project` with `ON DELETE RESTRICT`, so last month's statement can still resolve
 * its line items to a named project.
 */
const RETAINED_ON_DELETE = [
  "usage_event",
  "usage_rollup",
  "statement_line_item",
  "audit_log",
] as const

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
] as const

type JobRow = Pick<Selectable<DB["projectJob"]>, (typeof JOB_FIELDS)[number]>

function serializeJob(job: JobRow) {
  return {
    id: job.id,
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

function serializeProject(
  project: Pick<Selectable<DB["project"]>, (typeof PROJECT_FIELDS)[number]>,
  repository: { ownerLogin: string; name: string; provenance: string },
) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    kind: project.kind,
    state: project.state,
    stateReason: project.stateReason,
    rootDir: project.rootDir,
    dockerfilePath: project.dockerfilePath,
    productionBranch: project.productionBranch,
    autoUpdateEnabled: project.autoUpdateEnabled,
    autoUpdateMode: project.autoUpdateMode,
    repositoryId: project.repositoryId,
    storeListingId: project.storeListingId,
    agentCredentialId: project.agentCredentialId,
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
    ...serializeProject(project, repository),
    costMicroUsd: enriched?.costMicroUsd ?? "0",
    region: enriched?.region ?? null,
    hasUpstreamUpdate: enriched?.hasUpstreamUpdate ?? false,
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

  const resolved = await crudProjectUpdateSuggestion(db).resolve({
    id: suggestionId,
    projectId: project.id,
    status,
    userId: user.id,
  })

  if (resolved === undefined) {
    return throwNotFound(c, "No pending suggestion with that id")
  }

  let job: JobRow | undefined
  if (status === "accepted") {
    job = await crudProjectJob(db).create({
      kind: "sync_upstream",
      organizationId: organization.id,
      projectId: project.id,
      repositoryId: project.repositoryId,
      state: "queued",
      steps: JSON.stringify(initialSteps("sync_upstream")),
    })
  }

  await crudAuditLog(db).record({
    action: "project:update",
    actorUserId: user.id,
    after: { status: resolved.status, syncJobId: job?.id ?? null },
    before: { status: "pending" },
    organizationId: organization.id,
    resourceSrn: srnFor("project", organization.id, "update_suggestion", resolved.id),
    ...auditContext(c),
  })

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

      if (source.type === "repository") {
        const repository = await fetchRepository(db).getInOrganization(
          organization.id,
          source.repositoryId,
          ["id", "defaultBranch"],
        )
        if (!repository) return throwNotFound(c, "Repository not found")

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
        ])

        if (!listing || listing.status !== "published") {
          return throwBadRequest(
            c,
            "Listing is not available to fork",
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
            "No GitHub account to fork into. Sign in with GitHub, install the SproutOS GitHub App, or name the account with source.ownerLogin.",
            ErrorCode.ValidationFailed,
            { target: "source.ownerLogin" },
          )
        }

        storeListingId = listing.id
        listingRootDir = listing.rootDir
        listingDockerfilePath = listing.dockerfilePath
        jobKind = "fork"
        productionBranch ??= listing.defaultBranch
        plan = {
          defaultBranch: listing.defaultBranch,
          githubInstallationId: defaultInstallation?.id ?? null,
          isFork: true,
          mode: "create",
          name: source.repositoryName ?? listing.slug,
          ownerLogin,
          private: source.private ?? true,
          provenance: "fork",
          upstreamDefaultBranch: listing.defaultBranch,
          upstreamFullName: `${listing.upstreamOwner}/${listing.upstreamRepo}`,
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
        }
      }

      const rootDir = json.rootDir ?? listingRootDir ?? "."
      const dockerfilePath = json.dockerfilePath ?? listingDockerfilePath ?? "Dockerfile"

      if (plan.mode === "existing") {
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
      // is flat-rate, so nightly upkeep costs the customer nothing they are not already paying;
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
        actorUserId: user.id,
        agentCredentialId: credential?.id ?? null,
        audit: auditContext(c),
        autoUpdateEnabled: json.autoUpdateEnabled ?? autoUpdateDefaultFor(credential?.kind),
        autoUpdateMode: json.autoUpdateMode ?? "suggest",
        idempotencyKey:
          json.idempotencyKey === undefined
            ? null
            : `project:${organization.id}:${json.idempotencyKey}`,
        jobKind,
        kind: json.kind ?? "site",
        name: json.name,
        organizationId: organization.id,
        productionBranch,
        dockerfilePath,
        repository: plan,
        rootDir,
        slug,
        storeListingId,
      })

      /*
        Hand the job to the worker.

        The `project_job` row is the customer-visible progress record; this is what makes something
        happen. Until this line existed, `POST /projects` wrote a project, a repository with no
        `github_repo_id`, and four `pending` steps that nothing would ever move — a fork that
        returned 201 and created nothing on GitHub, forever.

        Keyed on the `project_job` id, so a duplicate enqueue collides rather than forking twice.
      */
      await enqueue(db, {
        kind: JOB_KINDS.provisionProject,
        idempotencyKey: `${JOB_KINDS.provisionProject}:${provisioned.job.id}`,
        payload: { projectJobId: provisioned.job.id, userId: user.id },
        // Three, not the default. The failures here are GitHub's 5xx and secondary rate limits,
        // which pass; a missing scope fails on the first attempt and would fail identically on the
        // tenth, so a larger number would only delay the error a customer needs to see.
        maxAttempts: 3,
      })

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

      const updated = await db.transaction().execute(async (tx) => {
        const row = await crudProject(tx).update(organization.id, projectId, {
          ...(json.name === undefined ? {} : { name: json.name }),
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
          ...(json.autoUpdateMode === undefined ? {} : { autoUpdateMode: json.autoUpdateMode }),
        })

        if (row === undefined) return undefined

        await crudAuditLog(tx).record({
          action: "project:update",
          actorUserId: user.id,
          after: {
            autoUpdateEnabled: row.autoUpdateEnabled,
            autoUpdateMode: row.autoUpdateMode,
            name: row.name,
            productionBranch: row.productionBranch,
            rootDir: row.rootDir,
            slug: row.slug,
          },
          before: {
            autoUpdateEnabled: before.autoUpdateEnabled,
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

      const result = await provisionProject(db).remove({
        actorUserId: user.id,
        audit: auditContext(c),
        organizationId: organization.id,
        projectId,
      })

      if (result === null) return throwNotFound(c, "Project not found")

      /*
        The teardown this route has always claimed to queue.

        The description says "queues its teardown", the message below says "a teardown job is
        queued", and `scheduledForTeardown` names nine kinds of resource. Nothing was enqueued:
        `provisionProject.remove` wrote a `project_job` of kind `delete` that no handler knew, and
        `JOB_KINDS` had no teardown at all. A deleted project's Knative service went on serving
        traffic and billing, its sandbox went on holding a node, and its backend services stayed
        provisioned with live credentials.

        Keyed on the project, so a second delete of the same project collides rather than tearing
        it down twice.
      */
      await enqueue(db, {
        kind: JOB_KINDS.tearDownProject,
        idempotencyKey: `${JOB_KINDS.tearDownProject}:${projectId}`,
        payload: { projectId, projectJobId: result.job.id },
        maxAttempts: 5,
      })

      const repositoryNote = result.repositoryReleased
        ? "The repository was released with it."
        : `The repository is still used by ${result.remainingProjectsOnRepository} other project(s) and was kept.`

      return c.json({
        destroyed: [],
        job: serializeJob(result.job),
        message:
          `Project "${result.project.slug}" is marked deleted and a teardown job is queued. ` +
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
