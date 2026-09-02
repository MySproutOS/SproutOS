import { sealEnvVarValue } from "@lib/envelope"
import {
  GITHUB_EVENT_KINDS,
  JOB_KINDS,
  DEPLOYMENT_CATALOGUE_REPOSITORY,
  DEPLOYMENT_TEMPLATES_REF,
  DEPLOYMENT_TEMPLATES_REPOSITORY,
  DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
  DEPLOYMENT_TEMPLATES_WORKFLOW_REF,
  GITHUB_ACTIONS_OIDC_ISSUER,
  enqueue,
  installationDiscoveryIdempotencyKey,
  manifestDigestForCatalogueEntry,
  parseCatalogueAppManifest,
  validateCatalogueUserInputs,
} from "@lib/jobs"
import {
  allocateProjectSlug,
  fetchCreditRetentionState,
  fetchDeploymentCatalogueImport,
  fetchGithubInstallation,
  fetchRegion,
  fetchStoreListing,
  isValidProjectSlug,
  provisionProject,
} from "@lib/dao"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { adminAuthMiddleware } from "../admin/middleware"
import { authMiddleware } from "../middleware"
import { collectionResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwError, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  templateAcceptanceSchemaParam,
  templateAcceptanceSchemaRequest,
  templateAcceptanceSchemaResponse,
} from "./template-acceptance.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const app = new Hono().use(authMiddleware).post(
  "/:orgSlug/store/listings/:listingId/acceptance-projects",
  describeRoute({
    description:
      "Creates a private production-acceptance project from an exact blocked signed catalogue listing without publishing it",
    responses: {
      201: {
        description: "The private acceptance project and immutable catalogue provenance",
        content: {
          "application/json": { schema: resolver(templateAcceptanceSchemaResponse) },
        },
      },
      400: {
        description: "Listing, region, slug, or template inputs are not eligible",
        ...errorResponse,
      },
      402: {
        description: "The organization is suspended for insufficient credit",
        ...errorResponse,
      },
      403: {
        description: "Caller is not an unimpersonated platform admin with project:create",
        ...errorResponse,
      },
      404: { description: "Organization or listing was not found", ...errorResponse },
    },
  }),
  adminAuthMiddleware,
  validator("param", templateAcceptanceSchemaParam),
  validator("json", templateAcceptanceSchemaRequest),
  requirePermission("project:create", collectionResource("project", "project")),
  async (c) => {
    const user = c.var.user
    const organization = c.var.organization
    const { listingId } = c.req.valid("param")
    const json = c.req.valid("json")

    if (await fetchCreditRetentionState(db).isUsageSuspended(organization.id)) {
      return throwError(
        c,
        402,
        ErrorCode.InsufficientCredit,
        "Add credit before creating a production-acceptance project.",
      )
    }

    const selectedRegion = await fetchRegion(db).getActiveByCode(json.region, ["id"])
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

    const listing = await fetchStoreListing(db).getOne(listingId, [
      "id",
      "slug",
      "status",
      "defaultBranch",
      "upstreamOwner",
      "upstreamRepo",
      "upstreamRepoUrl",
      "upstreamCommit",
      "rootDir",
      "dockerfilePath",
      "catalogueArchivedAt",
      "catalogueImportId",
      "catalogueEntryId",
      "templatePluginRepository",
      "templatePluginDigest",
      "capabilityVerifiedAt",
      "e2eVerifiedAt",
    ])
    if (listing === undefined) return throwNotFound(c, "Listing not found")
    if (
      listing.status !== "draft" ||
      listing.catalogueArchivedAt !== null ||
      listing.capabilityVerifiedAt !== null ||
      listing.e2eVerifiedAt !== null
    ) {
      return throwBadRequest(
        c,
        "Only an active, unverified draft catalogue listing can enter production acceptance",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }

    const catalogueManifest = await fetchStoreListing(db).getCatalogueManifest(listing.id)
    if (
      listing.catalogueImportId === null ||
      listing.catalogueEntryId === null ||
      catalogueManifest === undefined ||
      listing.templatePluginRepository === null ||
      listing.templatePluginDigest === null
    ) {
      return throwBadRequest(
        c,
        "Draft listing is not backed by a complete signed catalogue import",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }

    let manifest: ReturnType<typeof parseCatalogueAppManifest>
    try {
      manifest = parseCatalogueAppManifest(catalogueManifest)
    } catch {
      return throwBadRequest(
        c,
        "Draft listing carries an invalid signed catalogue manifest",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }
    if (
      manifest.id !== listing.catalogueEntryId ||
      listing.slug !== listing.catalogueEntryId ||
      manifest.readiness.status !== "blocked" ||
      manifest.readiness.e2e_evidence !== null ||
      manifest.plugin.repository !== listing.templatePluginRepository ||
      manifest.plugin.digest !== listing.templatePluginDigest ||
      manifest.repository.url !== listing.upstreamRepoUrl ||
      manifest.repository.commit !== listing.upstreamCommit
    ) {
      return throwBadRequest(
        c,
        "Draft listing does not carry the exact blocked, unevidenced signed manifest",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }

    const catalogueImport = await fetchDeploymentCatalogueImport(db).getOne(
      listing.catalogueImportId,
      [
        "ociRepository",
        "catalogueDigest",
        "sourceRepository",
        "workflowRef",
        "sourceRef",
        "sourceSha",
        "signatureIdentity",
        "signatureIssuer",
        "provenance",
      ],
    )
    if (catalogueImport === undefined) {
      return throwBadRequest(
        c,
        "Draft listing points at a missing signed catalogue import",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }
    if (
      catalogueImport.ociRepository !== DEPLOYMENT_CATALOGUE_REPOSITORY ||
      catalogueImport.sourceRepository !== DEPLOYMENT_TEMPLATES_REPOSITORY ||
      catalogueImport.workflowRef !== DEPLOYMENT_TEMPLATES_WORKFLOW_REF ||
      catalogueImport.sourceRef !== DEPLOYMENT_TEMPLATES_REF ||
      catalogueImport.signatureIdentity !== DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY ||
      catalogueImport.signatureIssuer !== GITHUB_ACTIONS_OIDC_ISSUER
    ) {
      return throwBadRequest(
        c,
        "Draft listing is not backed by the trusted catalogue publication identity",
        ErrorCode.ValidationFailed,
        { target: "listingId" },
      )
    }

    let resolvedInputs: ReturnType<typeof validateCatalogueUserInputs>
    try {
      resolvedInputs = validateCatalogueUserInputs(manifest.user_inputs, json.templateInputs ?? [])
    } catch (error) {
      return throwBadRequest(
        c,
        error instanceof Error ? error.message : "Template inputs are invalid",
        ErrorCode.ValidationFailed,
        { target: "templateInputs" },
      )
    }

    const projectId = v7()
    const environmentInputs = await Promise.all(
      resolvedInputs.map(async (input) => ({
        environment: input.environment,
        secret: input.secret,
        value: await sealEnvVarValue(projectId, input.environment, input.value),
      })),
    )
    const installation = await fetchGithubInstallation(db).listUsable(organization.id, [
      "id",
      "accountLogin",
    ])
    const matchingInstallation = installation.find(
      (candidate) => candidate.accountLogin.toLowerCase() === json.ownerLogin.toLowerCase(),
    )
    const slug = await allocateProjectSlug(db, organization.id, json.slug ?? json.name)
    const provisioned = await provisionProject(db).create({
      projectId,
      organizationId: organization.id,
      actorUserId: user.id,
      createdByOauthGrantId: null,
      name: json.name,
      slug,
      kind: "site",
      rootDir: listing.rootDir,
      dockerfilePath: listing.dockerfilePath,
      productionBranch: listing.defaultBranch,
      agentCredentialId: null,
      autoUpdateEnabled: false,
      autoUpdateCadence: "one_week",
      autoUpdateMode: "suggest",
      storeListingId: listing.id,
      templateInstall: {
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
      },
      repository: {
        mode: "create",
        provenance: "copy",
        ownerLogin: json.ownerLogin,
        name: json.repositoryName,
        defaultBranch: listing.defaultBranch,
        private: true,
        isFork: false,
        upstreamStrategy: "snapshot_copy",
        upstreamFullName: `${listing.upstreamOwner}/${listing.upstreamRepo}`,
        upstreamDefaultBranch: listing.defaultBranch,
        githubInstallationId: matchingInstallation?.id ?? null,
      },
      jobKind: "provision",
      regionId: selectedRegion.id,
      audit: auditContext(c),
      auditAction: "admin:store:acceptance-project:create",
      auditMetadata: {
        reason: json.reason,
        catalogueEntryId: listing.catalogueEntryId,
        catalogueImportId: listing.catalogueImportId,
        sourceSha: catalogueImport.sourceSha,
        pluginDigest: listing.templatePluginDigest,
        repositoryPrivate: true,
      },
    })

    await enqueue(db, {
      kind: JOB_KINDS.provisionProject,
      idempotencyKey: `${JOB_KINDS.provisionProject}:${provisioned.job.id}`,
      payload: { projectJobId: provisioned.job.id, userId: user.id },
      maxAttempts: 3,
    })
    await enqueue(db, {
      kind: GITHUB_EVENT_KINDS.installationDiscover,
      idempotencyKey: installationDiscoveryIdempotencyKey({
        login: json.ownerLogin,
        appId: process.env.GITHUB_APP_ID,
        operationId: provisioned.project.id,
        organizationId: organization.id,
      }),
      payload: {
        organizationId: organization.id,
        login: json.ownerLogin,
      },
      maxAttempts: 3,
    })

    return c.json(
      {
        projectId: provisioned.project.id,
        projectJobId: provisioned.job.id,
        repositoryId: provisioned.repository.id,
        storeListingId: listing.id,
        catalogueEntryId: listing.catalogueEntryId,
        catalogueImportId: listing.catalogueImportId,
        sourceSha: catalogueImport.sourceSha,
        pluginDigest: listing.templatePluginDigest,
        projectState: provisioned.project.state,
        jobState: provisioned.job.state,
        repository: {
          ownerLogin: provisioned.repository.ownerLogin,
          name: provisioned.repository.name,
          private: true as const,
        },
      },
      201,
    )
  },
)

export default app
