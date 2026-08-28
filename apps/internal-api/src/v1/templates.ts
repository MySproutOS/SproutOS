import { fetchDeploymentCatalogueImport, fetchStoreListing } from "@lib/dao"
import {
  catalogueTemplateApplyRequestFromManifest,
  DEPLOYMENT_CATALOGUE_REPOSITORY,
  DEPLOYMENT_TEMPLATES_REF,
  DEPLOYMENT_TEMPLATES_REPOSITORY,
  DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
  DEPLOYMENT_TEMPLATES_WORKFLOW_REF,
  GITHUB_ACTIONS_OIDC_ISSUER,
  manifestDigestForCatalogueEntry,
  parseCatalogueAppManifest,
} from "@lib/jobs"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwNotFound } from "../utils/http-exception"
import { validator } from "../utils/validator"
import { templateSchemaResolveRequest, templateSchemaResolveResponse } from "./templates.serializer"

const app = new Hono().use(authMiddleware).post(
  "/resolve",
  describeRoute({
    description: "Resolves one exact upstream commit from the signed deployment catalogue",
    responses: {
      200: {
        description: "Immutable plugin and protocol coordinates",
        content: { "application/json": { schema: resolver(templateSchemaResolveResponse) } },
      },
      404: {
        description: "No matching signed template",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
    },
  }),
  validator("json", templateSchemaResolveRequest),
  async (c) => {
    const selector = c.req.valid("json")
    const listing = await fetchStoreListing(db).getBySlug(selector.template_id, [
      "id",
      "status",
      "upstreamCommit",
      "catalogueImportId",
      "catalogueEntryId",
      "templatePluginRepository",
      "templatePluginDigest",
    ])
    if (
      listing === undefined ||
      listing.status !== "published" ||
      listing.upstreamCommit !== selector.upstream_commit ||
      listing.catalogueImportId === null ||
      listing.catalogueEntryId === null ||
      listing.templatePluginRepository === null ||
      listing.templatePluginDigest === null
    ) {
      return throwNotFound(c, "Signed template revision not found")
    }
    const manifestJson = await fetchStoreListing(db).getCatalogueManifest(listing.id)
    const catalogueImport = await fetchDeploymentCatalogueImport(db).getOne(
      listing.catalogueImportId,
      [
        "catalogueDigest",
        "ociDigest",
        "ociRepository",
        "sourceRepository",
        "sourceRef",
        "workflowRef",
        "sourceSha",
        "signatureIdentity",
        "signatureIssuer",
        "provenance",
      ],
    )
    if (
      manifestJson === undefined ||
      catalogueImport === undefined ||
      catalogueImport.ociRepository !== DEPLOYMENT_CATALOGUE_REPOSITORY ||
      !/^sha256:[0-9a-f]{64}$/.test(catalogueImport.ociDigest) ||
      !/^sha256:[0-9a-f]{64}$/.test(catalogueImport.catalogueDigest) ||
      catalogueImport.sourceRepository !== DEPLOYMENT_TEMPLATES_REPOSITORY ||
      catalogueImport.sourceRef !== DEPLOYMENT_TEMPLATES_REF ||
      catalogueImport.workflowRef !== DEPLOYMENT_TEMPLATES_WORKFLOW_REF ||
      catalogueImport.signatureIdentity !== DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY ||
      catalogueImport.signatureIssuer !== GITHUB_ACTIONS_OIDC_ISSUER ||
      !/^[0-9a-f]{40}$/.test(catalogueImport.sourceSha)
    ) {
      return throwNotFound(c, "Signed template revision not found")
    }
    const manifest = parseCatalogueAppManifest(manifestJson)
    if (
      listing.catalogueEntryId !== selector.template_id ||
      manifest.id !== selector.template_id ||
      manifest.repository.commit !== selector.upstream_commit ||
      manifest.plugin.repository !== listing.templatePluginRepository ||
      manifest.plugin.digest !== listing.templatePluginDigest ||
      manifest.plugin.protocol_version !== 1
    ) {
      return throwNotFound(c, "Signed template revision not found")
    }
    const manifestDigest = manifestDigestForCatalogueEntry(
      catalogueImport.provenance,
      listing.catalogueEntryId,
    )
    return c.json({
      template_id: manifest.id,
      upstream_commit: manifest.repository.commit,
      plugin_reference: `${listing.templatePluginRepository}@${listing.templatePluginDigest}`,
      plugin_digest: listing.templatePluginDigest,
      target: selector.target,
      provenance: {
        repository: DEPLOYMENT_TEMPLATES_REPOSITORY,
        workflow: ".github/workflows/publish.yml",
        git_ref: DEPLOYMENT_TEMPLATES_REF,
        source_commit: catalogueImport.sourceSha,
        oidc_issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        workflow_identity: DEPLOYMENT_TEMPLATES_WORKFLOW_REF,
        github_hosted_runner: true,
      },
      request: catalogueTemplateApplyRequestFromManifest(manifest, {
        catalogueDigest: catalogueImport.catalogueDigest,
        manifestDigest,
        pluginDigest: listing.templatePluginDigest,
      }),
    })
  },
)

export default app
