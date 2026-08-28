import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  appJwt,
  createGitHubClient,
  createInstallationTokenStore,
  envAppJwtSigner,
  type GitHubClient,
} from "@lib/github"

export const DEPLOYMENT_CATALOGUE_REPOSITORY = "ghcr.io/mysproutos/deployment-catalogue" as const
export const DEPLOYMENT_CATALOGUE_ARTIFACT_TYPE =
  "application/vnd.sproutos.deployment-catalogue.v1" as const
export const DEPLOYMENT_TEMPLATES_REPOSITORY = "MySproutOS/Deployment-Templates" as const
export const DEPLOYMENT_TEMPLATES_REF = "refs/heads/main" as const
export const DEPLOYMENT_TEMPLATES_WORKFLOW_REF =
  "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main" as const
export const DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY =
  "https://github.com/MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main" as const
export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const
export const DEPLOYMENT_CATALOGUE_RELEASE_API =
  "https://api.github.com/repos/MySproutOS/Deployment-Templates/releases?per_page=20" as const

const execFileAsync = promisify(execFile)
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_LAYER_BYTES = 8 * 1024 * 1024
const MAX_RELEASE_BYTES = 256 * 1024
const MAX_SUBJECTS_BYTES = 64 * 1024
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const GITHUB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

type OciDescriptor = {
  digest: string
  size: number
  mediaType?: string
  annotations?: Record<string, string>
}

type OciManifest = {
  schemaVersion: number
  artifactType?: string
  layers: OciDescriptor[]
}

export type DeploymentCatalogueArtifact = {
  ociDigest: string
  catalogue: Uint8Array
  provenance: Uint8Array
  pluginLock: Uint8Array
}

export type DeploymentCatalogueCoordinates = {
  ociDigest: string
  sourceSha: string
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} is not a sha256 OCI digest`)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function bearerChallenge(header: string | null): URL {
  if (header === null || !header.startsWith("Bearer ")) {
    throw new Error("the OCI registry did not return a Bearer authentication challenge")
  }
  const params = new Map<string, string>()
  for (const match of header.slice(7).matchAll(/([a-z]+)="([^"]+)"/g)) {
    params.set(match[1], match[2])
  }
  const realm = params.get("realm")
  if (realm === undefined) throw new Error("the OCI registry challenge has no realm")
  const url = new URL(realm)
  for (const key of ["service", "scope"] as const) {
    const value = params.get(key)
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url
}

async function publicRegistryToken(challenge: string | null): Promise<string> {
  const response = await fetch(bearerChallenge(challenge), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`the OCI registry token request returned ${response.status}`)
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== "string" || body.token === "") {
    throw new Error("the OCI registry token response carried no token")
  }
  return body.token
}

async function registryGet(path: string, accept: string): Promise<Response> {
  const url = `https://ghcr.io/v2/mysproutos/deployment-catalogue/${path}`
  let response = await fetch(url, {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 401) {
    const token = await publicRegistryToken(response.headers.get("www-authenticate"))
    response = await fetch(url, {
      headers: { Accept: accept, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
  }
  if (!response.ok) throw new Error(`OCI registry ${path} returned ${response.status}`)
  return response
}

async function boundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit)
    throw new Error(`${label} exceeds ${limit} bytes`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error(`${label} exceeds ${limit} bytes`)
  return bytes
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

async function githubGet(url: string, limit: number, label: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return await boundedBytes(response, limit, label)
}

/**
 * Resolve the latest completed catalogue publication without relying on an earlier database row.
 *
 * The immutable release is only a discovery pointer. Its asset digest and exact subject shape
 * prevent transport ambiguity; the caller must still verify the discovered OCI digest's Cosign
 * signature and GitHub provenance before enqueueing it, and the importer verifies them again.
 */
export async function discoverCurrentDeploymentCatalogue(): Promise<DeploymentCatalogueCoordinates> {
  const releasesValue = parseJson(
    await githubGet(
      DEPLOYMENT_CATALOGUE_RELEASE_API,
      MAX_RELEASE_BYTES,
      "Deployment-Templates releases",
    ),
    "Deployment-Templates releases",
  )
  if (!Array.isArray(releasesValue))
    throw new Error("Deployment-Templates releases is not an array")
  const releases = releasesValue.map((value) => object(value, "Deployment-Templates release"))
  const catalogueReleases = releases.filter(
    (candidate) =>
      candidate.draft === false &&
      candidate.prerelease === false &&
      typeof candidate.tag_name === "string" &&
      /^catalogue-[0-9a-f]{40}$/.test(candidate.tag_name),
  )
  if (catalogueReleases.length === 0)
    throw new Error("Deployment-Templates has no final catalogue release")
  for (const candidate of catalogueReleases) {
    if (
      typeof candidate.published_at !== "string" ||
      !GITHUB_TIMESTAMP_PATTERN.test(candidate.published_at)
    ) {
      throw new Error("Deployment-Templates catalogue release has no valid publication time")
    }
  }
  catalogueReleases.sort((left, right) =>
    (right.published_at as string).localeCompare(left.published_at as string),
  )
  const release = catalogueReleases[0]
  if (release.draft !== false || release.prerelease !== false || release.immutable !== true) {
    throw new Error("Deployment-Templates catalogue release is not a final immutable release")
  }

  const tag = release.tag_name
  const target = release.target_commitish
  if (typeof tag !== "string" || !/^catalogue-[0-9a-f]{40}$/.test(tag)) {
    throw new Error("Deployment-Templates release is not a catalogue release")
  }
  const sourceSha = tag.slice("catalogue-".length)
  if (target !== sourceSha || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("deployment catalogue release tag and source commit do not match")
  }

  if (!Array.isArray(release.assets)) {
    throw new Error("deployment catalogue release has no assets")
  }
  const assets = release.assets.map((value) => object(value, "deployment catalogue release asset"))
  const matchingAssets = assets.filter((asset) => asset.name === "subjects.json")
  if (matchingAssets.length !== 1) {
    throw new Error("deployment catalogue release must contain exactly one subjects.json asset")
  }
  const asset = matchingAssets[0]
  const expectedUrl = `https://github.com/MySproutOS/Deployment-Templates/releases/download/${tag}/subjects.json`
  if (
    asset.state !== "uploaded" ||
    asset.content_type !== "application/json" ||
    asset.browser_download_url !== expectedUrl ||
    typeof asset.digest !== "string" ||
    !DIGEST_PATTERN.test(asset.digest) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_SUBJECTS_BYTES
  ) {
    throw new Error("deployment catalogue subjects.json asset metadata is invalid")
  }

  const subjectsBytes = await githubGet(expectedUrl, MAX_SUBJECTS_BYTES, "catalogue subjects.json")
  if (subjectsBytes.byteLength !== asset.size || sha256(subjectsBytes) !== asset.digest) {
    throw new Error("catalogue subjects.json bytes do not match the immutable release asset")
  }
  const subjects = object(
    parseJson(subjectsBytes, "catalogue subjects.json"),
    "catalogue subjects.json",
  )
  if (
    subjects.schemaVersion !== 1 ||
    subjects.sourceCommit !== sourceSha ||
    !Array.isArray(subjects.subjects)
  ) {
    throw new Error("catalogue subjects.json does not match the release source commit")
  }
  const catalogues = subjects.subjects
    .map((value) => object(value, "catalogue subject"))
    .filter((subject) => subject.kind === "catalogue")
  if (catalogues.length !== 1) {
    throw new Error("catalogue subjects.json must contain exactly one catalogue subject")
  }
  const catalogue = catalogues[0]
  if (
    catalogue.id !== "catalogue" ||
    catalogue.name !== DEPLOYMENT_CATALOGUE_REPOSITORY ||
    catalogue.tag !== `sha-${sourceSha}` ||
    catalogue.layout !== "oci/catalogue" ||
    typeof catalogue.digest !== "string" ||
    !DIGEST_PATTERN.test(catalogue.digest)
  ) {
    throw new Error("catalogue subjects.json does not name the trusted catalogue artifact")
  }
  return { ociDigest: catalogue.digest, sourceSha }
}

function parseManifest(bytes: Uint8Array): OciManifest {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<OciManifest>
  if (value.schemaVersion !== 2 || value.artifactType !== DEPLOYMENT_CATALOGUE_ARTIFACT_TYPE) {
    throw new Error("OCI manifest is not a SproutOS deployment catalogue v1 artifact")
  }
  if (!Array.isArray(value.layers) || value.layers.length !== 3) {
    throw new Error("deployment catalogue OCI artifact must contain exactly three layers")
  }
  for (const layer of value.layers) {
    if (typeof layer !== "object" || layer === null) throw new Error("invalid OCI layer descriptor")
    assertDigest(layer.digest, "OCI layer digest")
    if (!Number.isSafeInteger(layer.size) || layer.size < 0 || layer.size > MAX_LAYER_BYTES) {
      throw new Error("OCI layer descriptor has an invalid size")
    }
  }
  return value as OciManifest
}

function layerTitle(layer: OciDescriptor): string | undefined {
  return layer.annotations?.["org.opencontainers.image.title"]
}

export async function pullDeploymentCatalogue(
  ociDigest: string,
): Promise<DeploymentCatalogueArtifact> {
  assertDigest(ociDigest, "catalogue OCI digest")
  const manifestResponse = await registryGet(
    `manifests/${ociDigest}`,
    "application/vnd.oci.image.manifest.v1+json",
  )
  const headerDigest = manifestResponse.headers.get("docker-content-digest")
  if (headerDigest !== null && headerDigest !== ociDigest) {
    throw new Error(`registry resolved ${ociDigest} as ${headerDigest}`)
  }
  const manifestBytes = await boundedBytes(manifestResponse, MAX_MANIFEST_BYTES, "OCI manifest")
  if (sha256(manifestBytes) !== ociDigest) throw new Error("OCI manifest bytes do not match digest")
  const manifest = parseManifest(manifestBytes)

  const entries = await Promise.all(
    manifest.layers.map(async (layer) => {
      const title = layerTitle(layer)
      if (!title || !["catalogue.json", "provenance.json", "plugin-lock.json"].includes(title)) {
        throw new Error(`unexpected deployment catalogue OCI layer ${String(title)}`)
      }
      const response = await registryGet(
        `blobs/${layer.digest}`,
        layer.mediaType ?? "application/octet-stream",
      )
      const bytes = await boundedBytes(response, MAX_LAYER_BYTES, title)
      if (bytes.byteLength !== layer.size || sha256(bytes) !== layer.digest) {
        throw new Error(`${title} bytes do not match the OCI descriptor`)
      }
      return [title, bytes] as const
    }),
  )
  const named = new Map(entries)
  if (named.size !== entries.length) throw new Error("duplicate deployment catalogue OCI layer")

  const catalogue = named.get("catalogue.json")
  const provenance = named.get("provenance.json")
  const pluginLock = named.get("plugin-lock.json")
  if (!catalogue || !provenance || !pluginLock)
    throw new Error("deployment catalogue layers are incomplete")
  return { ociDigest, catalogue, provenance, pluginLock }
}

export type VerifiedAttestation = Record<string, unknown>

type ExecOptions = {
  timeout: number
  maxBuffer: number
  env?: NodeJS.ProcessEnv
}

type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>

type CatalogueVerificationDependencies = {
  exec: Exec
  githubToken: () => Promise<string>
}

const defaultExec: Exec = async (command, args, options) =>
  await execFileAsync(command, [...args], options)

/**
 * Finds the App installation that can see Deployment-Templates, then mints the narrow token used
 * only by `gh attestation verify`. The store caches that token in-process until five minutes before
 * expiry; the installation lookup is deliberately repeated so uninstall/reinstall takes effect
 * without waiting for a worker restart.
 */
function createCatalogueGitHubTokenProvider(
  client: GitHubClient,
  signJwt: () => string,
): () => Promise<string> {
  const tokens = createInstallationTokenStore({ client, signJwt })

  return async () => {
    const response = await client.request<{ id?: unknown }>({
      method: "GET",
      path: "/repos/MySproutOS/Deployment-Templates/installation",
      credential: appJwt(signJwt()),
    })
    const installationId = response.data.id
    if (
      typeof installationId !== "number" ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      throw new Error(
        "GitHub did not return a valid App installation for MySproutOS/Deployment-Templates",
      )
    }

    const credential = await tokens.get(installationId, {
      purpose: "catalogue-attestation-read",
    })
    if (credential.token === "") {
      throw new Error("GitHub returned an empty Deployment-Templates installation token")
    }
    return credential.token
  }
}

let defaultGitHubToken: (() => Promise<string>) | null = null

function productionGitHubToken(): Promise<string> {
  defaultGitHubToken ??= createCatalogueGitHubTokenProvider(createGitHubClient(), envAppJwtSigner())
  return defaultGitHubToken()
}

function safeVerificationError(error: unknown, token: string): Error {
  const unsafeMessage = error instanceof Error ? error.message : String(error)
  const message = token === "" ? unsafeMessage : unsafeMessage.replaceAll(token, "[REDACTED]")
  return new Error(`GitHub catalogue attestation verification failed: ${message}`)
}

function githubAttestationVerifyArguments(reference: string, sourceSha: string): string[] {
  return [
    "attestation",
    "verify",
    `oci://${reference}`,
    "--repo",
    DEPLOYMENT_TEMPLATES_REPOSITORY,
    "--signer-workflow",
    "MySproutOS/Deployment-Templates/.github/workflows/publish.yml",
    // GitHub CLI treats --signer-workflow and --cert-identity as mutually exclusive identity
    // policies. Cosign immediately above enforces the exact certificate SAN; this verifier pins
    // the repository, workflow, source ref/SHA, hosted runner, and default GitHub OIDC issuer.
    "--cert-oidc-issuer",
    GITHUB_ACTIONS_OIDC_ISSUER,
    "--source-ref",
    DEPLOYMENT_TEMPLATES_REF,
    "--source-digest",
    sourceSha,
    "--deny-self-hosted-runners",
    "--bundle-from-oci",
    "--format=json",
  ]
}

export async function verifyDeploymentCatalogueProvenance(
  ociDigest: string,
  sourceSha: string,
  dependencies: CatalogueVerificationDependencies = {
    exec: defaultExec,
    githubToken: productionGitHubToken,
  },
): Promise<VerifiedAttestation[]> {
  assertDigest(ociDigest, "catalogue OCI digest")
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("catalogue source SHA is invalid")
  const reference = `${DEPLOYMENT_CATALOGUE_REPOSITORY}@${ociDigest}`

  await dependencies.exec(
    "cosign",
    [
      "verify",
      "--certificate-identity",
      DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
      "--certificate-oidc-issuer",
      GITHUB_ACTIONS_OIDC_ISSUER,
      reference,
    ],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  )

  const githubToken = await dependencies.githubToken()
  let result: { stdout: string; stderr: string }
  try {
    result = await dependencies.exec("gh", githubAttestationVerifyArguments(reference, sourceSha), {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: githubToken },
    })
  } catch (error) {
    throw safeVerificationError(error, githubToken)
  }
  const attestations = JSON.parse(result.stdout) as unknown
  if (!Array.isArray(attestations) || attestations.length === 0) {
    throw new Error("GitHub returned no verified catalogue provenance attestation")
  }
  return attestations as VerifiedAttestation[]
}

export const deploymentCatalogueInternals = {
  createCatalogueGitHubTokenProvider,
  githubAttestationVerifyArguments,
  parseManifest,
  sha256,
}
