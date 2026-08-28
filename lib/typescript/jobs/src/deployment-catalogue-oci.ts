import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

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

const execFileAsync = promisify(execFile)
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_LAYER_BYTES = 8 * 1024 * 1024
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

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

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`${label} is not a sha256 OCI digest`)
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

export async function verifyDeploymentCatalogueProvenance(
  ociDigest: string,
  sourceSha: string,
): Promise<VerifiedAttestation[]> {
  assertDigest(ociDigest, "catalogue OCI digest")
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("catalogue source SHA is invalid")
  const reference = `${DEPLOYMENT_CATALOGUE_REPOSITORY}@${ociDigest}`

  await execFileAsync(
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

  const result = await execFileAsync(
    "gh",
    [
      "attestation",
      "verify",
      `oci://${reference}`,
      "--repo",
      DEPLOYMENT_TEMPLATES_REPOSITORY,
      "--signer-workflow",
      "MySproutOS/Deployment-Templates/.github/workflows/publish.yml",
      "--cert-identity",
      DEPLOYMENT_TEMPLATES_SIGNER_IDENTITY,
      "--cert-oidc-issuer",
      GITHUB_ACTIONS_OIDC_ISSUER,
      "--source-ref",
      DEPLOYMENT_TEMPLATES_REF,
      "--source-digest",
      sourceSha,
      "--deny-self-hosted-runners",
      "--bundle-from-oci",
      "--format=json",
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  )
  const attestations = JSON.parse(result.stdout) as unknown
  if (!Array.isArray(attestations) || attestations.length === 0) {
    throw new Error("GitHub returned no verified catalogue provenance attestation")
  }
  return attestations as VerifiedAttestation[]
}

export const deploymentCatalogueInternals = { parseManifest, sha256 }
