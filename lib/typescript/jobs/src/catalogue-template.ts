import { randomBytes } from "node:crypto"
import { checkout, commitAndPush } from "@lib/agent"
import { availableBalance } from "@lib/billing"
import {
  crudProjectEnvVar,
  crudProjectTemplateInstall,
  crudProjectTemplateService,
  fetchCreditRetentionState,
  fetchProjectEnvVar,
  fetchProjectTemplateInstall,
  fetchProjectTemplateService,
} from "@lib/dao"
import { sealEnvVarValue } from "@lib/envelope"
import {
  parseObjectStorageUri,
  serviceDriverFromEnv,
  type ProvisionResult,
  type ServiceDriver,
} from "@lib/services"
import type { DB, Json } from "@sproutos/db"
import type { ApplyTemplateResult } from "@sproutos/sprout-node"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import {
  parseCatalogueAppManifest,
  type CatalogueApp,
  type CatalogueUserInput,
} from "./deployment-catalogue-schema"
import { withProjectLock } from "./project-lock"

export type TemplateInstallState =
  | "configuring"
  | "provisioning"
  | "forking"
  | "preparing"
  | "deploying"
  | "ready"
  | "failed"

export type SubmittedCatalogueInput = {
  key: string
  value: string | number | boolean
  secret: boolean
}

export type ResolvedCatalogueInput = {
  key: string
  environment: string
  value: string
  secret: boolean
}

function resolvedInputValue(definition: CatalogueUserInput, value: unknown): string {
  if (definition.type === "string") {
    if (typeof value !== "string") throw new Error(`${definition.key} must be a string`)
    if (value.length > 8192 || value.includes("\0")) {
      throw new Error(`${definition.key} contains an invalid string value`)
    }
    return value
  }
  if (definition.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`${definition.key} must be a safe integer`)
    }
    return String(value)
  }
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${definition.key} must be a boolean`)
    return String(value)
  }
  if (typeof value !== "string") throw new Error(`${definition.key} must be a URL`)
  if (value.length > 8192 || value.includes("\0")) {
    throw new Error(`${definition.key} contains an invalid URL value`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${definition.key} must be a URL`)
  }
  if (
    !(["http:", "https:"] as string[]).includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`${definition.key} must be an HTTP(S) URL without embedded credentials`)
  }
  return value
}

/** Resolve only keys and types authorized by the immutable signed manifest. */
export function validateCatalogueUserInputs(
  definitions: readonly CatalogueUserInput[],
  submitted: readonly SubmittedCatalogueInput[],
): ResolvedCatalogueInput[] {
  if (submitted.length > 64) throw new Error("too many template inputs were supplied")
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  if (byKey.size !== definitions.length)
    throw new Error("signed template has duplicate user input keys")

  const seen = new Set<string>()
  const resolved = submitted.map((input) => {
    if (typeof input.secret !== "boolean") {
      throw new Error(`template input ${input.key} must declare whether it is secret`)
    }
    if (seen.has(input.key))
      throw new Error(`template input ${input.key} was supplied more than once`)
    seen.add(input.key)
    const definition = byKey.get(input.key)
    if (definition === undefined) throw new Error(`template input ${input.key} is not declared`)
    return {
      key: definition.key,
      environment: definition.environment,
      value: resolvedInputValue(definition, input.value),
      secret: input.secret,
    }
  })

  const missing = definitions.find((definition) => definition.required && !seen.has(definition.key))
  if (missing !== undefined) throw new Error(`required template input ${missing.key} is missing`)
  return resolved
}

/** The ordering seam: every side effect is injected, so the production sequence is testable. */
export async function orchestrateCatalogueTemplate<TRepository>(operations: {
  transition: (state: TemplateInstallState) => Promise<void>
  configure: () => Promise<void>
  provisionServices: () => Promise<void>
  fork: () => Promise<TRepository>
  prepareAndPush: (repository: TRepository) => Promise<void>
}): Promise<TRepository> {
  await operations.transition("configuring")
  await operations.configure()
  await operations.transition("provisioning")
  await operations.provisionServices()
  await operations.transition("forking")
  const repository = await operations.fork()
  await operations.transition("preparing")
  await operations.prepareAndPush(repository)
  await operations.transition("deploying")
  return repository
}

export type CatalogueTemplateContext = {
  projectId: string
  organizationId: string
  manifest: CatalogueApp
  catalogueDigest: string
  manifestDigest: string
  pluginRepository: string
  pluginDigest: string
  deploymentTemplatesCommit: string
  preparedCommitSha: string | null
  configuredInputs: { key: string; environment: string; secret: boolean }[]
}

function parseConfiguredInputs(value: Json): CatalogueTemplateContext["configuredInputs"] {
  if (!Array.isArray(value)) throw new Error("template configured input provenance is invalid")
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).toSorted().join(",") !== "environment,key,secret" ||
      typeof entry.key !== "string" ||
      typeof entry.environment !== "string" ||
      typeof entry.secret !== "boolean"
    ) {
      throw new Error("template configured input provenance is invalid")
    }
    return { key: entry.key, environment: entry.environment, secret: entry.secret }
  })
}

export async function catalogueTemplateContext(
  db: Kysely<DB>,
  projectId: string,
): Promise<CatalogueTemplateContext | null> {
  const installs = fetchProjectTemplateInstall(db)
  const [install, raw] = await Promise.all([
    installs.getOne(projectId, [
      "organizationId",
      "catalogueDigest",
      "manifestDigest",
      "pluginRepository",
      "pluginDigest",
      "deploymentTemplatesCommit",
      "preparedCommitSha",
    ]),
    installs.getRawConfiguration(projectId),
  ])
  if (install === undefined && raw === undefined) return null
  if (install === undefined || raw === undefined) {
    throw new Error(`template install for ${projectId} is internally inconsistent`)
  }
  return {
    projectId,
    organizationId: install.organizationId,
    manifest: parseCatalogueAppManifest(raw.manifest),
    catalogueDigest: install.catalogueDigest,
    manifestDigest: install.manifestDigest,
    pluginRepository: install.pluginRepository,
    pluginDigest: install.pluginDigest,
    deploymentTemplatesCommit: install.deploymentTemplatesCommit,
    preparedCommitSha: install.preparedCommitSha,
    configuredInputs: parseConfiguredInputs(raw.configuredInputs),
  }
}

export async function transitionTemplateInstall(
  db: Kysely<DB>,
  projectId: string,
  state: TemplateInstallState,
): Promise<void> {
  const updated = await crudProjectTemplateInstall(db).update(projectId, {
    state,
    ...(state === "failed" ? {} : { failureCode: null, failureMessage: null }),
  })
  if (updated === undefined) throw new Error(`template install for ${projectId} disappeared`)
}

type ManifestService = {
  key: string
  kind: "postgres" | "valkey" | "elasticsearch" | "object_storage"
  bindings: { environment: string; output: string }[]
}

/** Encode an array for a JSONB query parameter instead of node-postgres' PostgreSQL-array path. */
export function encodeTemplateServiceBindings(bindings: ManifestService["bindings"]): string {
  return JSON.stringify(bindings)
}

type GeneratedInput = {
  key: string
  generator: "random_base64url"
  bytes: number
  environment: string
}

export async function configureGeneratedInputs(
  db: Kysely<DB>,
  context: CatalogueTemplateContext,
): Promise<void> {
  const existing = new Set(
    (await fetchProjectEnvVar(db).listForProject(context.projectId)).map(({ key }) => key),
  )
  const generated = context.manifest.generated_inputs as GeneratedInput[]
  await Promise.all(
    generated.map(async (input) => {
      if (existing.has(input.environment)) return
      const value = randomBytes(input.bytes).toString("base64url")
      const sealed = await sealEnvVarValue(context.projectId, input.environment, value)
      await crudProjectEnvVar(db).upsert({
        projectId: context.projectId,
        key: input.environment,
        target: "all",
        isSecret: true,
        value: sealed,
      })
    }),
  )
}

/** Internal callers cannot bypass the API's required-input gate. */
export async function verifyUserInputsConfigured(
  db: Kysely<DB>,
  context: CatalogueTemplateContext,
): Promise<void> {
  const definitions = new Map(context.manifest.user_inputs.map((input) => [input.key, input]))
  const configuredKeys = new Set<string>()
  for (const configured of context.configuredInputs) {
    if (configuredKeys.has(configured.key)) {
      throw new Error(`template input ${configured.key} has duplicate configuration provenance`)
    }
    configuredKeys.add(configured.key)
    const definition = definitions.get(configured.key)
    if (definition === undefined || definition.environment !== configured.environment) {
      throw new Error(`template input ${configured.key} configuration provenance is not declared`)
    }
  }
  const missingDeclaration = context.manifest.user_inputs.find(
    (input) => input.required && !configuredKeys.has(input.key),
  )
  if (missingDeclaration !== undefined) {
    throw new Error(`required template input ${missingDeclaration.key} is not configured`)
  }
  if (context.configuredInputs.length === 0) return
  const existing = new Map(
    (await fetchProjectEnvVar(db).listForProject(context.projectId)).map(({ key, isSecret }) => [
      key,
      isSecret,
    ]),
  )
  const missing = context.configuredInputs.find(
    (input) => existing.get(input.environment) !== input.secret,
  )
  if (missing !== undefined) {
    throw new Error(
      `template input ${missing.key} configuration does not match its persisted value`,
    )
  }
}

function bindingValue(
  kind: ManifestService["kind"],
  connection: {
    connectionUri: string
    host: string
    port: number
    database: string
    username: string
  },
  output: string,
): { secret: boolean; value: string } {
  const url = new URL(connection.connectionUri)
  const object = kind === "object_storage" ? parseObjectStorageUri(connection.connectionUri) : null
  switch (output) {
    case "connection_url":
      return { secret: true, value: connection.connectionUri }
    case "endpoint":
      return {
        secret: false,
        value: object?.endpoint ?? `${url.protocol}//${connection.host}:${connection.port}`,
      }
    case "username":
      return { secret: false, value: connection.username }
    case "password":
      return { secret: true, value: decodeURIComponent(url.password) }
    case "region":
      if (object !== null) return { secret: false, value: object.region }
      break
    case "bucket":
      if (object !== null) return { secret: false, value: object.bucket }
      return { secret: false, value: connection.database }
    case "access_key_id":
      if (object !== null) return { secret: true, value: object.accessKeyId }
      break
    case "secret_access_key":
      if (object !== null) return { secret: true, value: object.secretAccessKey }
      break
    case "force_path_style":
      if (object !== null) return { secret: false, value: String(object.forcePathStyle) }
      break
  }
  throw new Error(`${kind} cannot provide template service output ${output}`)
}

type TemplateServiceProvisionRecord = {
  backendServiceId: string
  provisioned: boolean
}

export async function reconcileTemplateServiceProvision(operations: {
  serialized: <T>(work: () => Promise<T>) => Promise<T>
  load: () => Promise<TemplateServiceProvisionRecord | undefined>
  create: () => Promise<TemplateServiceProvisionRecord>
  provision: (backendServiceId: string) => Promise<ProvisionResult>
  recover: (backendServiceId: string) => Promise<ProvisionResult>
  persistBindings: (result: ProvisionResult) => Promise<void>
  finish: (backendServiceId: string) => Promise<void>
  fail: (backendServiceId: string) => Promise<void>
}): Promise<void> {
  await operations.serialized(async () => {
    const loaded = await operations.load()
    if (loaded?.provisioned === true) return

    const record = loaded ?? (await operations.create())
    try {
      const result =
        loaded === undefined
          ? await operations.provision(record.backendServiceId)
          : await operations.recover(record.backendServiceId)
      await operations.persistBindings(result)
      await operations.finish(record.backendServiceId)
    } catch (error) {
      await operations.fail(record.backendServiceId)
      throw error
    }
  })
}

export async function recoverTemplateService(
  driver: ServiceDriver,
  input: Parameters<ServiceDriver["provision"]>[0],
): Promise<ProvisionResult> {
  if (driver.recoverProvision === undefined) {
    throw new Error(`${driver.kind} driver cannot reconcile an interrupted provision safely`)
  }
  return await driver.recoverProvision(input)
}

export async function provisionTemplateServices(
  db: Kysely<DB>,
  context: CatalogueTemplateContext,
  keepAlive?: () => Promise<boolean>,
): Promise<void> {
  if (
    context.manifest.services.length > 0 &&
    (await fetchCreditRetentionState(db).isUsageSuspended(context.organizationId))
  ) {
    throw new Error("The organization is suspended; add credit before provisioning services")
  }
  if (
    context.manifest.services.length > 0 &&
    (await availableBalance(db, context.organizationId)) <= 0n
  ) {
    throw new Error("A positive credit balance is required to provision catalogue services")
  }
  const project = await db
    .selectFrom("project")
    .select(["regionId"])
    .where("id", "=", context.projectId)
    .where("organizationId", "=", context.organizationId)
    .executeTakeFirstOrThrow()
  const region =
    project.regionId === null
      ? await db.selectFrom("region").select("id").where("isActive", "=", true).executeTakeFirst()
      : { id: project.regionId }
  if (region === undefined) throw new Error("no active region can host catalogue services")

  const services = context.manifest.services as ManifestService[]
  for (const service of services) {
    await reconcileTemplateServiceProvision({
      serialized: async (work) => await withProjectLock(db, context.projectId, work, { keepAlive }),
      load: async () => {
        const existing = await fetchProjectTemplateService(db).getOne(
          context.projectId,
          service.key,
          ["backendServiceId", "bindings", "kind", "provisionedAt"],
        )
        if (existing === undefined) return undefined
        if (
          existing.kind !== service.kind ||
          JSON.stringify(existing.bindings) !== JSON.stringify(service.bindings)
        ) {
          throw new Error(
            `template service ${context.projectId}/${service.key} no longer matches its signed manifest`,
          )
        }
        return {
          backendServiceId: existing.backendServiceId,
          provisioned: existing.provisionedAt !== null,
        }
      },
      create: async () => {
        const backendServiceId = v7()
        await db.transaction().execute(async (tx) => {
          await tx
            .insertInto("backendService")
            .values({
              id: backendServiceId,
              organizationId: context.organizationId,
              projectId: context.projectId,
              regionId: region.id,
              name: service.key,
              kind: service.kind,
              status: "provisioning",
            })
            .execute()
          await crudProjectTemplateService(tx).create({
            projectId: context.projectId,
            serviceKey: service.key,
            backendServiceId,
            kind: service.kind,
            // node-postgres encodes a JavaScript array as a PostgreSQL array literal. The target
            // column is jsonb, so that arrives as `{...}` and PostgreSQL rejects it as invalid
            // JSON before the provider is ever called. Serialize JSON arrays explicitly, matching
            // the other JSONB writers in the provisioning transaction.
            bindings: encodeTemplateServiceBindings(service.bindings),
          })
        })
        return { backendServiceId, provisioned: false }
      },
      provision: async (backendServiceId) =>
        await serviceDriverFromEnv(db, service.kind).provision({
          backendServiceId,
          organizationId: context.organizationId,
          projectId: context.projectId,
          name: service.key,
        }),
      recover: async (backendServiceId) =>
        await recoverTemplateService(serviceDriverFromEnv(db, service.kind), {
          backendServiceId,
          organizationId: context.organizationId,
          projectId: context.projectId,
          name: service.key,
        }),
      persistBindings: async (result) => {
        await Promise.all(
          service.bindings.map(async (binding) => {
            const resolved = bindingValue(service.kind, result, binding.output)
            const sealed = await sealEnvVarValue(
              context.projectId,
              binding.environment,
              resolved.value,
            )
            await crudProjectEnvVar(db).upsert({
              projectId: context.projectId,
              key: binding.environment,
              target: "all",
              isSecret: resolved.secret,
              value: sealed,
            })
          }),
        )
      },
      finish: async (backendServiceId) => {
        await db.transaction().execute(async (tx) => {
          await tx
            .updateTable("backendService")
            .set({ status: "active", updatedAt: new Date() })
            .where("id", "=", backendServiceId)
            .execute()
          await crudProjectTemplateService(tx).markProvisioned(context.projectId, service.key)
        })
      },
      fail: async (backendServiceId) => {
        await db
          .updateTable("backendService")
          .set({ status: "error", updatedAt: new Date() })
          .where("id", "=", backendServiceId)
          .execute()
      },
    })
  }
}

export async function applyCatalogueTemplate(input: {
  db: Kysely<DB>
  context: CatalogueTemplateContext
  owner: string
  repository: string
  branch: string
  token: string
}): Promise<{ sha: string; result: ApplyTemplateResult }> {
  const workspace = await checkout({
    owner: input.owner,
    repo: input.repository,
    ref: input.branch,
    token: input.token,
  })
  try {
    // Lazy by design: API and scheduler containers share the worker bundle but never execute
    // native templates. Only the ECS worker must load the platform-specific addon.
    const { applyTemplate } = await import("@sproutos/sprout-node")
    const result = await applyTemplate({
      workspacePath: workspace.path,
      pluginReference: `${input.context.pluginRepository}@${input.context.pluginDigest}`,
      pluginDigest: input.context.pluginDigest as `sha256:${string}`,
      deploymentTemplatesCommit: input.context.deploymentTemplatesCommit,
      request: catalogueTemplateApplyRequest(input.context),
    })
    const committed = await commitAndPush({
      workspace,
      owner: input.owner,
      repo: input.repository,
      token: input.token,
      branch: input.branch,
      message: `Configure ${input.context.manifest.name} for SproutOS`,
    })
    if (!committed.committed) throw new Error("signed template produced no repository changes")
    await crudProjectTemplateInstall(input.db).update(input.context.projectId, {
      applyResult: result as unknown as Json,
      preparedCommitSha: committed.sha,
    })
    return { sha: committed.sha, result }
  } finally {
    await workspace.dispose()
  }
}

/** Structural declarations only: customer values and even their secret flags stay outside N-API. */
export function catalogueTemplateApplyRequest(
  context: CatalogueTemplateContext,
): Record<string, unknown> {
  return catalogueTemplateApplyRequestFromManifest(context.manifest, {
    catalogueDigest: context.catalogueDigest,
    manifestDigest: context.manifestDigest,
    pluginDigest: context.pluginDigest,
  })
}

export function catalogueTemplateApplyRequestFromManifest(
  manifest: CatalogueApp,
  identity: { catalogueDigest: string; manifestDigest: string; pluginDigest: string },
): Record<string, unknown> {
  return {
    protocol_version: 1,
    workspace: "/workspace",
    template: {
      id: manifest.id,
      catalogue_digest: identity.catalogueDigest,
      manifest_digest: identity.manifestDigest,
      plugin_digest: identity.pluginDigest,
      upstream_repository: manifest.repository.url,
      upstream_commit: manifest.repository.commit,
    },
    deployment: {
      preset: manifest.deployment.preset,
      capabilities: manifest.deployment.required_capabilities,
    },
    services: manifest.services,
    user_inputs: manifest.user_inputs,
    generated_inputs: manifest.generated_inputs,
  }
}

export async function failTemplateInstall(
  db: Kysely<DB>,
  projectId: string,
  cause: unknown,
): Promise<void> {
  await crudProjectTemplateInstall(db).update(projectId, {
    state: "failed",
    failureCode: cause instanceof Error ? cause.name : "Error",
    failureMessage: cause instanceof Error ? cause.message : String(cause),
  })
}
