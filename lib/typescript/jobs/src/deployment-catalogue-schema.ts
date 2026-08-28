import { createHash } from "node:crypto"
import {
  DEPLOYMENT_TEMPLATES_REF,
  DEPLOYMENT_TEMPLATES_REPOSITORY,
} from "./deployment-catalogue-oci"

const TOKEN = /^[a-z0-9][a-z0-9._-]*$/
const COMMIT = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const ENVIRONMENT = /^[A-Z_][A-Z0-9_]*$/

export type CatalogueReadiness = {
  status: "blocked" | "live" | "retired"
  blocked_reasons: string[]
  e2e_evidence: null | {
    workflow_run_url: string
    tested_at: string
    upstream_commit: string
    plugin_digest: string
  }
}

export type CatalogueApp = {
  schema_version: 1
  id: string
  name: string
  pitch: string
  description_md: string
  homepage: string | null
  repository: { url: string; commit: string }
  license: string
  platform: "web" | "android"
  readiness: CatalogueReadiness
  plugin: { repository: string; digest: string; protocol_version: 1 }
  deployment: {
    preset: string
    runtime: string
    architecture: "arm64" | "x86_64"
    migration: null | { kind: "artifact"; path: string }
    required_capabilities: string[]
  }
  services: unknown[]
  user_inputs: unknown[]
  generated_inputs: unknown[]
}

export type DeploymentCatalogue = {
  schema_version: 1
  generated_from_commit: string
  apps: CatalogueApp[]
}

export type CatalogueProvenance = {
  schema_version: 1
  repository: typeof DEPLOYMENT_TEMPLATES_REPOSITORY
  workflow: ".github/workflows/publish.yml"
  ref: typeof DEPLOYMENT_TEMPLATES_REF
  source_commit: string
  subject: { kind: "catalogue"; name: "catalogue/catalogue.json"; digest: string }
  materials: { uri: string; digest: string }[]
}

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  const expected = keys.toSorted()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`)
  }
}

function text(value: unknown, label: string, minimum = 1, maximum?: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    (maximum !== undefined && value.length > maximum)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function pattern(value: unknown, expression: RegExp, label: string): string {
  const result = text(value, label)
  if (!expression.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function uniqueStrings(
  value: unknown,
  label: string,
  validate: (entry: string) => boolean,
): string[] {
  const result = array(value, label).map((entry, index) => {
    const item = text(entry, `${label}[${index}]`)
    if (!validate(item)) throw new Error(`${label}[${index}] is invalid`)
    return item
  })
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`)
  return result
}

function httpsUrl(value: unknown, label: string): string {
  const result = text(value, label)
  let url: URL
  try {
    url = new URL(result)
  } catch {
    throw new Error(`${label} is not a URL`)
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use https`)
  return result
}

function relativePath(value: unknown, label: string): string {
  const result = text(value, label)
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    result.includes("//") ||
    result.split("/").some((part) => part === "." || part === "..") ||
    result === ".git" ||
    result.startsWith(".git/")
  ) {
    throw new Error(`${label} is not a safe relative path`)
  }
  return result
}

function parseReadiness(value: unknown, label: string): CatalogueReadiness {
  const row = object(value, label)
  exactKeys(row, ["status", "blocked_reasons", "e2e_evidence"], label)
  if (!(["blocked", "live", "retired"] as unknown[]).includes(row.status)) {
    throw new Error(`${label}.status is invalid`)
  }
  const status = row.status as CatalogueReadiness["status"]
  const blockedReasons = uniqueStrings(row.blocked_reasons, `${label}.blocked_reasons`, () => true)
  let evidence: CatalogueReadiness["e2e_evidence"] = null
  if (row.e2e_evidence !== null) {
    const item = object(row.e2e_evidence, `${label}.e2e_evidence`)
    exactKeys(
      item,
      ["workflow_run_url", "tested_at", "upstream_commit", "plugin_digest"],
      `${label}.e2e_evidence`,
    )
    const workflowRunUrl = httpsUrl(item.workflow_run_url, `${label}.e2e_evidence.workflow_run_url`)
    if (
      !/^https:\/\/github\.com\/MySproutOS\/Deployment-Templates\/actions\/runs\/[0-9]+$/.test(
        workflowRunUrl,
      )
    ) {
      throw new Error(`${label}.e2e_evidence.workflow_run_url is invalid`)
    }
    const testedAt = text(item.tested_at, `${label}.e2e_evidence.tested_at`)
    if (!Number.isFinite(Date.parse(testedAt)))
      throw new Error(`${label}.e2e_evidence.tested_at is invalid`)
    evidence = {
      workflow_run_url: workflowRunUrl,
      tested_at: testedAt,
      upstream_commit: pattern(
        item.upstream_commit,
        COMMIT,
        `${label}.e2e_evidence.upstream_commit`,
      ),
      plugin_digest: pattern(item.plugin_digest, DIGEST, `${label}.e2e_evidence.plugin_digest`),
    }
  }
  if (status === "blocked" && (blockedReasons.length === 0 || evidence !== null)) {
    throw new Error(`${label} blocked entries require reasons and no E2E evidence`)
  }
  if (status === "live" && (blockedReasons.length !== 0 || evidence === null)) {
    throw new Error(`${label} live entries require E2E evidence and no blockers`)
  }
  if (status === "retired" && blockedReasons.length !== 0) {
    throw new Error(`${label} retired entries cannot carry blockers`)
  }
  return { status, blocked_reasons: blockedReasons, e2e_evidence: evidence }
}

function validateBindings(value: unknown, label: string): unknown[] {
  const rows = array(value, label)
  if (rows.length === 0) throw new Error(`${label} cannot be empty`)
  return rows.map((entry, index) => {
    const row = object(entry, `${label}[${index}]`)
    exactKeys(row, ["environment", "output"], `${label}[${index}]`)
    pattern(row.environment, ENVIRONMENT, `${label}[${index}].environment`)
    if (
      !(
        [
          "connection_url",
          "endpoint",
          "username",
          "password",
          "region",
          "bucket",
          "access_key_id",
          "secret_access_key",
          "force_path_style",
        ] as unknown[]
      ).includes(row.output)
    ) {
      throw new Error(`${label}[${index}].output is invalid`)
    }
    return row
  })
}

function validateServices(value: unknown, label: string): unknown[] {
  return array(value, label).map((entry, index) => {
    const row = object(entry, `${label}[${index}]`)
    exactKeys(row, ["key", "kind", "bindings"], `${label}[${index}]`)
    pattern(row.key, TOKEN, `${label}[${index}].key`)
    if (
      !(["postgres", "valkey", "elasticsearch", "object_storage"] as unknown[]).includes(row.kind)
    ) {
      throw new Error(`${label}[${index}].kind is invalid`)
    }
    validateBindings(row.bindings, `${label}[${index}].bindings`)
    return row
  })
}

function validateUserInputs(value: unknown, label: string): unknown[] {
  return array(value, label).map((entry, index) => {
    const row = object(entry, `${label}[${index}]`)
    exactKeys(row, ["key", "type", "environment", "required"], `${label}[${index}]`)
    pattern(row.key, TOKEN, `${label}[${index}].key`)
    pattern(row.environment, ENVIRONMENT, `${label}[${index}].environment`)
    if (!(["string", "url", "integer", "boolean"] as unknown[]).includes(row.type)) {
      throw new Error(`${label}[${index}].type is invalid`)
    }
    if (typeof row.required !== "boolean") throw new Error(`${label}[${index}].required is invalid`)
    return row
  })
}

function validateGeneratedInputs(value: unknown, label: string): unknown[] {
  return array(value, label).map((entry, index) => {
    const row = object(entry, `${label}[${index}]`)
    exactKeys(row, ["key", "generator", "bytes", "environment"], `${label}[${index}]`)
    pattern(row.key, TOKEN, `${label}[${index}].key`)
    pattern(row.environment, ENVIRONMENT, `${label}[${index}].environment`)
    if (row.generator !== "random_base64url")
      throw new Error(`${label}[${index}].generator is invalid`)
    if (!Number.isInteger(row.bytes) || (row.bytes as number) < 32 || (row.bytes as number) > 128) {
      throw new Error(`${label}[${index}].bytes is invalid`)
    }
    return row
  })
}

function parseApp(value: unknown, index: number): CatalogueApp {
  const label = `catalogue.apps[${index}]`
  const row = object(value, label)
  exactKeys(
    row,
    [
      "schema_version",
      "id",
      "name",
      "pitch",
      "description_md",
      "homepage",
      "repository",
      "license",
      "platform",
      "readiness",
      "plugin",
      "deployment",
      "services",
      "user_inputs",
      "generated_inputs",
    ],
    label,
  )
  if (row.schema_version !== 1) throw new Error(`${label}.schema_version is unsupported`)
  const repository = object(row.repository, `${label}.repository`)
  exactKeys(repository, ["url", "commit"], `${label}.repository`)
  const plugin = object(row.plugin, `${label}.plugin`)
  exactKeys(plugin, ["repository", "digest", "protocol_version"], `${label}.plugin`)
  if (plugin.protocol_version !== 1)
    throw new Error(`${label}.plugin.protocol_version is unsupported`)
  const pluginRepository = pattern(
    plugin.repository,
    /^ghcr\.io\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/,
    `${label}.plugin.repository`,
  )
  const deployment = object(row.deployment, `${label}.deployment`)
  exactKeys(
    deployment,
    ["preset", "runtime", "architecture", "migration", "required_capabilities"],
    `${label}.deployment`,
  )
  if (!(["arm64", "x86_64"] as unknown[]).includes(deployment.architecture))
    throw new Error(`${label}.deployment.architecture is invalid`)
  let migration: CatalogueApp["deployment"]["migration"] = null
  if (deployment.migration !== null) {
    const item = object(deployment.migration, `${label}.deployment.migration`)
    exactKeys(item, ["kind", "path"], `${label}.deployment.migration`)
    if (item.kind !== "artifact") throw new Error(`${label}.deployment.migration.kind is invalid`)
    migration = {
      kind: "artifact",
      path: relativePath(item.path, `${label}.deployment.migration.path`),
    }
  }
  if (!(["web", "android"] as unknown[]).includes(row.platform))
    throw new Error(`${label}.platform is invalid`)
  const homepage = row.homepage === null ? null : httpsUrl(row.homepage, `${label}.homepage`)
  const result: CatalogueApp = {
    schema_version: 1,
    id: pattern(row.id, TOKEN, `${label}.id`),
    name: text(row.name, `${label}.name`, 1, 120),
    pitch: text(row.pitch, `${label}.pitch`, 1, 240),
    description_md: text(row.description_md, `${label}.description_md`),
    homepage,
    repository: {
      url: httpsUrl(repository.url, `${label}.repository.url`),
      commit: pattern(repository.commit, COMMIT, `${label}.repository.commit`),
    },
    license: text(row.license, `${label}.license`),
    platform: row.platform as "web" | "android",
    readiness: parseReadiness(row.readiness, `${label}.readiness`),
    plugin: {
      repository: pluginRepository,
      digest: pattern(plugin.digest, DIGEST, `${label}.plugin.digest`),
      protocol_version: 1,
    },
    deployment: {
      preset: pattern(deployment.preset, TOKEN, `${label}.deployment.preset`),
      runtime: pattern(deployment.runtime, TOKEN, `${label}.deployment.runtime`),
      architecture: deployment.architecture as "arm64" | "x86_64",
      migration,
      required_capabilities: uniqueStrings(
        deployment.required_capabilities,
        `${label}.deployment.required_capabilities`,
        (item) => TOKEN.test(item),
      ),
    },
    services: validateServices(row.services, `${label}.services`),
    user_inputs: validateUserInputs(row.user_inputs, `${label}.user_inputs`),
    generated_inputs: validateGeneratedInputs(row.generated_inputs, `${label}.generated_inputs`),
  }
  const evidence = result.readiness.e2e_evidence
  if (
    evidence !== null &&
    (evidence.upstream_commit !== result.repository.commit ||
      evidence.plugin_digest !== result.plugin.digest)
  ) {
    throw new Error(`${label}.readiness evidence does not match the pinned app artifacts`)
  }
  return result
}

/** Revalidate the immutable manifest snapshot before a worker trusts it. */
export function parseCatalogueAppManifest(value: unknown): CatalogueApp {
  return parseApp(value, 0)
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("catalogue contains a non-canonical number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const row = object(value, "canonical JSON value")
  return `{${Object.keys(row)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
    .join(",")}}`
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  const source = Buffer.from(bytes).toString("utf8")
  if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) {
    throw new Error(`${label} is not canonical JSON followed by one LF`)
  }
  const value = JSON.parse(source) as unknown
  if (`${canonical(value)}\n` !== source) throw new Error(`${label} is not RFC8785 canonical JSON`)
  return value
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

export function parseDeploymentCatalogue(
  bytes: Uint8Array,
  sourceSha: string,
): DeploymentCatalogue {
  const row = object(parseCanonicalJson(bytes, "catalogue.json"), "catalogue")
  exactKeys(row, ["schema_version", "generated_from_commit", "apps"], "catalogue")
  if (row.schema_version !== 1) throw new Error("catalogue.schema_version is unsupported")
  const generated = pattern(row.generated_from_commit, COMMIT, "catalogue.generated_from_commit")
  if (generated !== sourceSha) throw new Error("catalogue source commit does not match GitHub OIDC")
  const apps = array(row.apps, "catalogue.apps").map(parseApp)
  if (new Set(apps.map((app) => app.id)).size !== apps.length)
    throw new Error("catalogue app IDs are not unique")
  return { schema_version: 1, generated_from_commit: generated, apps }
}

export function parseCatalogueProvenance(
  bytes: Uint8Array,
  catalogueBytes: Uint8Array,
  sourceSha: string,
): CatalogueProvenance {
  const row = object(parseCanonicalJson(bytes, "provenance.json"), "provenance")
  exactKeys(
    row,
    ["schema_version", "repository", "workflow", "ref", "source_commit", "subject", "materials"],
    "provenance",
  )
  if (
    row.schema_version !== 1 ||
    row.repository !== DEPLOYMENT_TEMPLATES_REPOSITORY ||
    row.workflow !== ".github/workflows/publish.yml" ||
    row.ref !== DEPLOYMENT_TEMPLATES_REF ||
    row.source_commit !== sourceSha
  ) {
    throw new Error("provenance source identity does not match the trusted catalogue workflow")
  }
  const subject = object(row.subject, "provenance.subject")
  exactKeys(subject, ["kind", "name", "digest"], "provenance.subject")
  if (
    subject.kind !== "catalogue" ||
    subject.name !== "catalogue/catalogue.json" ||
    subject.digest !== digest(catalogueBytes)
  ) {
    throw new Error("provenance subject does not match catalogue.json")
  }
  const materials = array(row.materials, "provenance.materials").map((value, index) => {
    const item = object(value, `provenance.materials[${index}]`)
    exactKeys(item, ["uri", "digest"], `provenance.materials[${index}]`)
    return {
      uri: text(item.uri, `provenance.materials[${index}].uri`),
      digest: pattern(item.digest, DIGEST, `provenance.materials[${index}].digest`),
    }
  })
  if (materials.length === 0) throw new Error("provenance.materials cannot be empty")
  if (new Set(materials.map(({ uri }) => uri)).size !== materials.length) {
    throw new Error("provenance.materials contains duplicate URIs")
  }
  return {
    schema_version: 1,
    repository: DEPLOYMENT_TEMPLATES_REPOSITORY,
    workflow: ".github/workflows/publish.yml",
    ref: DEPLOYMENT_TEMPLATES_REF,
    source_commit: sourceSha,
    subject: {
      kind: "catalogue",
      name: "catalogue/catalogue.json",
      digest: subject.digest,
    },
    materials,
  }
}

export function verifyPluginLock(
  bytes: Uint8Array,
  apps: readonly CatalogueApp[],
  provenance: CatalogueProvenance,
): void {
  const row = object(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown, "plugin-lock")
  exactKeys(row, ["schemaVersion", "plugins"], "plugin-lock")
  if (row.schemaVersion !== 1) throw new Error("plugin-lock schema version is unsupported")
  const lockDigest = digest(bytes)
  if (
    !provenance.materials.some(
      ({ uri, digest: materialDigest }) =>
        uri === "catalogue/plugin-lock.json" && materialDigest === lockDigest,
    )
  ) {
    throw new Error("plugin-lock bytes do not match catalogue provenance")
  }
  const plugins = object(row.plugins, "plugin-lock.plugins")
  if (
    Object.keys(plugins).toSorted().join("\0") !==
    apps
      .map((app) => app.id)
      .toSorted()
      .join("\0")
  )
    throw new Error("plugin-lock app set does not match catalogue")
  const material = new Set(provenance.materials.map((entry) => `${entry.uri}\0${entry.digest}`))
  for (const app of apps) {
    const item = object(plugins[app.id], `plugin-lock.plugins.${app.id}`)
    exactKeys(item, ["artifact"], `plugin-lock.plugins.${app.id}`)
    const expected = `${app.plugin.repository}@${app.plugin.digest}`
    if (item.artifact !== expected || !material.has(`${expected}\0${app.plugin.digest}`))
      throw new Error(`plugin-lock provenance does not match ${app.id}`)
  }
}

/** Resolve the signed source-manifest digest recorded by the imported catalogue provenance. */
export function manifestDigestForCatalogueEntry(provenance: unknown, entryId: string): string {
  const row = object(provenance, "catalogue provenance")
  const materials = array(row.materials, "catalogue provenance.materials")
  const uri = `apps/${entryId}/manifest-source.json`
  for (const [index, value] of materials.entries()) {
    const material = object(value, `catalogue provenance.materials[${index}]`)
    if (material.uri === uri) {
      return pattern(material.digest, DIGEST, `catalogue provenance material ${uri}`)
    }
  }
  throw new Error(`catalogue provenance has no source manifest for ${entryId}`)
}

export const deploymentCatalogueSchemaInternals = { canonical, digest }
