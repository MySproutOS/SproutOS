import { createHash } from "node:crypto"
import { crudDeploymentCatalogueImport, type CatalogueListingInput } from "@lib/dao"
import type { DB, Json } from "@sproutos/db"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"
import {
  DEPLOYMENT_CATALOGUE_REPOSITORY,
  DEPLOYMENT_TEMPLATES_REF,
  DEPLOYMENT_TEMPLATES_REPOSITORY,
  DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
  DEPLOYMENT_TEMPLATES_WORKFLOW_REF,
  discoverCurrentDeploymentCatalogue,
  GITHUB_ACTIONS_OIDC_ISSUER,
  pullDeploymentCatalogue,
  verifyDeploymentCatalogueProvenance,
  type DeploymentCatalogueArtifact,
  type VerifiedAttestation,
} from "./deployment-catalogue-oci"
import {
  parseCatalogueProvenance,
  parseDeploymentCatalogue,
  verifyPluginLock,
  type CatalogueApp,
} from "./deployment-catalogue-schema"
import { enqueue } from "./queue"

export const DEPLOYMENT_CATALOGUE_IMPORT_KIND = "catalogue.import_signed" as const
export const DEPLOYMENT_CATALOGUE_DISCOVERY_KIND = "catalogue.discover_signed" as const
/**
 * Part of both scheduled idempotency keys. Bump only when a verifier change must create a fresh
 * path past terminal jobs left by the prior verifier; the old dead letter remains as audit evidence.
 */
export const DEPLOYMENT_CATALOGUE_VERIFIER_GENERATION = "github-app-v1" as const

export function isTrustedDeploymentCatalogueWorkflow(claims: {
  repository: string
  ref: string
  workflowRef: string
  sha: string
}): boolean {
  return (
    claims.repository === DEPLOYMENT_TEMPLATES_REPOSITORY &&
    claims.ref === DEPLOYMENT_TEMPLATES_REF &&
    claims.workflowRef === DEPLOYMENT_TEMPLATES_WORKFLOW_REF &&
    /^[0-9a-f]{40}$/.test(claims.sha)
  )
}

type CatalogueImportDependencies = {
  pull: (digest: string) => Promise<DeploymentCatalogueArtifact>
  verify: (digest: string, sourceSha: string) => Promise<VerifiedAttestation[]>
}

type CatalogueDiscoveryDependencies = {
  discover: typeof discoverCurrentDeploymentCatalogue
  verify: typeof verifyDeploymentCatalogueProvenance
  queue: typeof enqueue
}

const defaultDependencies: CatalogueImportDependencies = {
  pull: pullDeploymentCatalogue,
  verify: verifyDeploymentCatalogueProvenance,
}

const defaultDiscoveryDependencies: CatalogueDiscoveryDependencies = {
  discover: discoverCurrentDeploymentCatalogue,
  verify: verifyDeploymentCatalogueProvenance,
  queue: enqueue,
}

function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function repositoryCoordinates(app: CatalogueApp): { owner: string; repo: string } {
  const url = new URL(app.repository.url)
  const parts = url.pathname.split("/").filter(Boolean)
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 2 ||
    parts[1].endsWith(".git")
  ) {
    throw new Error(`catalogue app ${app.id} does not name an exact GitHub repository URL`)
  }
  return { owner: parts[0], repo: parts[1] }
}

function listing(app: CatalogueApp): CatalogueListingInput {
  const repository = repositoryCoordinates(app)
  const evidence = app.readiness.e2e_evidence
  const verifiedAt =
    app.readiness.status === "live" && evidence !== null ? new Date(evidence.tested_at) : null
  const status =
    app.readiness.status === "live"
      ? "published"
      : app.readiness.status === "retired"
        ? "archived"
        : "draft"
  return {
    id: app.id,
    name: app.name,
    pitch: app.pitch,
    descriptionMd: app.description_md,
    homepage: app.homepage,
    platform: app.platform,
    license: app.license,
    upstreamOwner: repository.owner,
    upstreamRepo: repository.repo,
    upstreamRepoUrl: app.repository.url,
    upstreamCommit: app.repository.commit,
    pluginRepository: app.plugin.repository,
    pluginDigest: app.plugin.digest,
    requiredCapabilities: app.deployment.required_capabilities,
    readiness: json(app.readiness),
    manifest: json(app),
    status,
    verifiedAt,
  }
}

export async function reconcileSignedDeploymentCatalogue(
  db: Kysely<DB>,
  ociDigest: string,
  sourceSha: string,
  dependencies: CatalogueImportDependencies = defaultDependencies,
): Promise<{ importId: string; upserted: number; archived: number }> {
  const artifact = await dependencies.pull(ociDigest)
  if (artifact.ociDigest !== ociDigest)
    throw new Error("catalogue pull returned another OCI digest")
  const attestations = await dependencies.verify(ociDigest, sourceSha)
  const catalogue = parseDeploymentCatalogue(artifact.catalogue, sourceSha)
  const provenance = parseCatalogueProvenance(artifact.provenance, artifact.catalogue, sourceSha)
  verifyPluginLock(artifact.pluginLock, catalogue.apps, provenance)

  return await crudDeploymentCatalogueImport(db).reconcile({
    ociRepository: DEPLOYMENT_CATALOGUE_REPOSITORY,
    ociDigest,
    catalogueDigest: `sha256:${createHash("sha256").update(artifact.catalogue).digest("hex")}`,
    sourceRepository: DEPLOYMENT_TEMPLATES_REPOSITORY,
    workflowRef: DEPLOYMENT_TEMPLATES_WORKFLOW_REF,
    sourceRef: DEPLOYMENT_TEMPLATES_REF,
    sourceSha,
    signatureIdentity: DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
    signatureIssuer: GITHUB_ACTIONS_OIDC_ISSUER,
    provenance: json({ document: provenance, attestations }),
    listings: catalogue.apps.map(listing),
  })
}

export function importDeploymentCatalogue(
  dependencies: CatalogueImportDependencies = defaultDependencies,
): JobHandler {
  return async (job, { db }) => {
    const payload = job.payload as { ociDigest?: unknown; sourceSha?: unknown }
    if (
      typeof payload.ociDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(payload.ociDigest) ||
      typeof payload.sourceSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(payload.sourceSha)
    ) {
      throw new Error("catalogue import job requires an OCI digest and source SHA")
    }
    const result = await reconcileSignedDeploymentCatalogue(
      db,
      payload.ociDigest,
      payload.sourceSha,
      dependencies,
    )
    console.info(
      `[catalogue] reconciled ${result.upserted} listing(s), archived ${result.archived}, import=${result.importId}`,
    )
  }
}

/**
 * Resolve the latest immutable release without trusting prior database state, prove that exact OCI
 * digest came from the pinned Deployment-Templates workflow, then hand it to the normal importer.
 * The importer deliberately repeats provenance verification immediately before its transaction.
 */
export function discoverDeploymentCatalogue(
  dependencies: CatalogueDiscoveryDependencies = defaultDiscoveryDependencies,
): JobHandler {
  return async (job, { db }) => {
    const payload = job.payload as { window?: unknown }
    if (typeof payload.window !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.window)) {
      throw new Error("catalogue discovery job requires a UTC day window")
    }

    const discovered = await dependencies.discover()
    await dependencies.verify(discovered.ociDigest, discovered.sourceSha)
    const importId = await dependencies.queue(db, {
      kind: DEPLOYMENT_CATALOGUE_IMPORT_KIND,
      payload: discovered,
      idempotencyKey: `${DEPLOYMENT_CATALOGUE_IMPORT_KIND}:discovered:${DEPLOYMENT_CATALOGUE_VERIFIER_GENERATION}:${payload.window}:${discovered.ociDigest}`,
      maxAttempts: 5,
    })
    console.info(
      `[catalogue] discovered ${discovered.ociDigest} from ${discovered.sourceSha}, import=${importId}`,
    )
  }
}

export async function scheduleDeploymentCatalogueReconciliation(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<string> {
  const window = now.toISOString().slice(0, 10)
  return await enqueue(db, {
    kind: DEPLOYMENT_CATALOGUE_DISCOVERY_KIND,
    payload: { window },
    idempotencyKey: `${DEPLOYMENT_CATALOGUE_DISCOVERY_KIND}:${DEPLOYMENT_CATALOGUE_VERIFIER_GENERATION}:${window}`,
    maxAttempts: 5,
  })
}
