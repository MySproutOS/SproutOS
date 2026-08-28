import { randomBytes } from "node:crypto"
import { checkout, commitAndPush } from "@lib/agent"
import { availableBalance } from "@lib/billing"
import {
  crudProjectEnvVar,
  crudProjectTemplateInstall,
  crudProjectTemplateService,
  fetchProjectEnvVar,
  fetchProjectTemplateInstall,
  fetchProjectTemplateService,
} from "@lib/dao"
import { sealEnvVarValue } from "@lib/envelope"
import { parseObjectStorageUri, serviceDriverFromEnv } from "@lib/services"
import type { DB, Json } from "@sproutos/db"
import type { ApplyTemplateResult } from "@sproutos/sprout-node"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { parseCatalogueAppManifest, type CatalogueApp } from "./deployment-catalogue-schema"

export type TemplateInstallState =
  | "configuring"
  | "provisioning"
  | "forking"
  | "preparing"
  | "deploying"
  | "ready"
  | "failed"

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
}

export async function catalogueTemplateContext(
  db: Kysely<DB>,
  projectId: string,
): Promise<CatalogueTemplateContext | null> {
  const install = await fetchProjectTemplateInstall(db).getOne(projectId, [
    "organizationId",
    "manifest",
    "catalogueDigest",
    "manifestDigest",
    "pluginRepository",
    "pluginDigest",
    "deploymentTemplatesCommit",
    "preparedCommitSha",
  ])
  if (install === undefined) return null
  return {
    projectId,
    organizationId: install.organizationId,
    manifest: parseCatalogueAppManifest(install.manifest),
    catalogueDigest: install.catalogueDigest,
    manifestDigest: install.manifestDigest,
    pluginRepository: install.pluginRepository,
    pluginDigest: install.pluginDigest,
    deploymentTemplatesCommit: install.deploymentTemplatesCommit,
    preparedCommitSha: install.preparedCommitSha,
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

export class TemplateServiceRecoveryRequiredError extends Error {
  override readonly name = "TemplateServiceRecoveryRequiredError"
  constructor(projectId: string, serviceKey: string) {
    super(
      `Template service ${projectId}/${serviceKey} was interrupted while provisioning; refusing to mint a second credential`,
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

export async function provisionTemplateServices(
  db: Kysely<DB>,
  context: CatalogueTemplateContext,
): Promise<void> {
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
    const existing = await fetchProjectTemplateService(db).getOne(context.projectId, service.key, [
      "backendServiceId",
      "provisionedAt",
    ])
    if (existing !== undefined && existing.provisionedAt !== null) continue
    if (existing !== undefined) {
      throw new TemplateServiceRecoveryRequiredError(context.projectId, service.key)
    }

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
        bindings: service.bindings,
      })
    })

    try {
      const result = await serviceDriverFromEnv(db, service.kind).provision({
        backendServiceId,
        organizationId: context.organizationId,
        projectId: context.projectId,
        name: service.key,
      })
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
      await db.transaction().execute(async (tx) => {
        await tx
          .updateTable("backendService")
          .set({ status: "active", updatedAt: new Date() })
          .where("id", "=", backendServiceId)
          .execute()
        await crudProjectTemplateService(tx).markProvisioned(context.projectId, service.key)
      })
    } catch (error) {
      await db
        .updateTable("backendService")
        .set({ status: "error", updatedAt: new Date() })
        .where("id", "=", backendServiceId)
        .execute()
      throw error
    }
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
      request: {
        protocol_version: 1,
        workspace: "/workspace",
        template: {
          id: input.context.manifest.id,
          catalogue_digest: input.context.catalogueDigest,
          manifest_digest: input.context.manifestDigest,
          plugin_digest: input.context.pluginDigest,
          upstream_repository: input.context.manifest.repository.url,
          upstream_commit: input.context.manifest.repository.commit,
        },
        deployment: {
          preset: input.context.manifest.deployment.preset,
          capabilities: input.context.manifest.deployment.required_capabilities,
        },
        services: input.context.manifest.services,
        user_inputs: input.context.manifest.user_inputs,
        generated_inputs: input.context.manifest.generated_inputs,
      },
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
