import { DeleteAliasCommand, LambdaClient } from "@aws-sdk/client-lambda"
import { CloudFrontKeyValueStoreClient } from "@aws-sdk/client-cloudfront-keyvaluestore"
import { Route53Client } from "@aws-sdk/client-route-53"
import { S3Client } from "@aws-sdk/client-s3"
import { crudDeployment, fetchDeployment, fetchProjectEnvVar, fetchProjectFile } from "@lib/dao"
import { openEnvVarValue } from "@lib/envelope"
import {
  DEFAULT_HANDLER,
  DEFAULT_RUNTIME,
  functionName,
  hostLabel,
  isSupportedRuntime,
  pointAlias,
  publishFunction,
  webAdapterLayerArn,
  runMigration,
  publishLiveDeployment,
  publishRoute,
  withdrawRoute,
  type Route,
} from "@lib/lambda"
import type { DB } from "@sproutos/db"
import { Redis } from "ioredis"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"
import { withProjectLock } from "./project-lock"
import { logExtensionLayerForProject } from "./log-extension"
import { enqueue } from "./queue"
import {
  deactivateStaticHost,
  pointStaticSite,
  publishStaticSite,
  removeStaticDeployment,
  removeStaticDeploymentBytes,
  staticPlatformFromEnv,
  type StaticPublisherClients,
} from "./static-publish"

/**
 * Putting a release live: publish the function, then publish the route.
 *
 * This replaces the Knative half of `deployRevision`. Under ADR 0026 a deployment is a zip in S3
 * that Lambda reads rather than an image a cluster pulls, and going live is publishing a version
 * and moving an alias rather than waiting for a revision to become ready.
 *
 * **The wait is gone, and that is the substantive difference.** The Knative handler polled for
 * ninety seconds and handed the remainder back to the queue, because a revision pulling a large
 * image can take minutes and a handler that blocks holds a worker slot and a lease. Lambda has no
 * equivalent state: `PublishVersion` returns when the version exists, and the first request pays
 * the cold start. So this handler runs once and finishes.
 */

export const PUBLISH_KINDS = {
  release: "deploy.release",
  tearDownPreview: "deploy.preview_teardown",
  cleanUpStaticPreview: "deploy.static_preview_cleanup",
} as const

export type MigrationResumeAction = "run" | "publish" | "stop" | "ambiguous"

/** Decide how a reclaimed/retried release continues without applying its migration twice. */
export function migrationResumeAction(status: string | null): MigrationResumeAction {
  if (status === "succeeded") return "publish"
  if (status === "failed") return "stop"
  if (status === "running") return "ambiguous"
  return "run"
}

type PublishPayload = { deploymentId: string }

/** The domain tenant applications are served from. */
function tenantDomain(): string {
  return process.env.TENANT_DOMAIN ?? "sproutos.me"
}

/** Lambda's own defaults for a project that has not chosen. */
const DEFAULT_MEMORY_MB = 512
const DEFAULT_TIMEOUT_S = 30

/** Keep a long synchronous migration from outliving the queue lease that owns it. */
async function withLeaseHeartbeat<T>(
  keepAlive: () => Promise<boolean>,
  work: () => Promise<T>,
): Promise<T> {
  if (!(await keepAlive())) throw new Error("Lost ownership of the deployment job before migration")

  let heartbeatFailure: Error | undefined
  const timer = setInterval(() => {
    void keepAlive()
      .then((held) => {
        if (!held)
          heartbeatFailure = new Error("Lost ownership of the deployment job during migration")
      })
      .catch((error: unknown) => {
        heartbeatFailure = error instanceof Error ? error : new Error(String(error))
      })
  }, 60_000)
  timer.unref()

  try {
    const result = await work()
    if (heartbeatFailure !== undefined) throw heartbeatFailure
    return result
  } finally {
    clearInterval(timer)
  }
}

export type PublishOptions = {
  lambda: LambdaClient
  valkey: Redis
  bucket?: string
  roleArn?: string
  static?: StaticPublisherClients & {
    bucket: string
    tenantZoneId: string
    distributionDomain: string
    keyValueStoreArn: string
  }
}

/*
  Clients built on first use, never at import.

  `PLATFORM_HANDLERS` is a module-scope object literal, so anything constructed inside it runs when
  the module loads. A `new Redis(...)` there opens a connection as a side effect of importing the
  handler registry — which kept the OpenAPI generator's process alive until it timed out at three
  minutes, and would keep a CLI or a migration alive the same way.
*/
let shared:
  | {
      lambda: LambdaClient
      valkey: Redis
      static: StaticPublisherClients
    }
  | undefined
function sharedClients(): {
  lambda: LambdaClient
  valkey: Redis
  static: StaticPublisherClients
} {
  const aws = {
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL }),
  }
  shared ??= {
    lambda: new LambdaClient(aws),
    // The platform's own Valkey, where the route map lives — not the tenant instance.
    valkey: new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023"),
    static: {
      s3: new S3Client({ ...aws, forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined }),
      route53: new Route53Client(aws),
      // CloudFront KVS is global but signs against us-east-1. It is never pointed at LocalStack;
      // static tests inject a fake because LocalStack has no KVS implementation.
      keyValueStore: new CloudFrontKeyValueStoreClient({ region: "us-east-1" }),
    },
  }
  return shared
}

/**
 * Decrypt a project's variables for one deployment target.
 *
 * Straight into Lambda's `Environment.Variables` — there is no Secret object any more, and no
 * `envFrom`. Lambda encrypts environment variables at rest with a KMS key by default, which is the
 * property the Kubernetes Secret was there to provide.
 *
 * **`target` is the deployment's own kind plus `all`.** A preview gets the preview variables and
 * the shared ones, and production's secrets stay out of a pull request's build — which matters,
 * because a preview runs code from a branch anybody with a fork can open.
 */
export async function environmentFor(
  db: Kysely<DB>,
  projectId: string,
  target: string,
): Promise<Record<string, string>> {
  const sealed = await fetchProjectEnvVar(db).listSealedForProject(projectId, target)
  const variables: Record<string, string> = {}

  for (const row of sealed) {
    variables[row.key] = await openEnvVarValue(projectId, row.key, {
      ciphertext: row.valueCiphertext,
      kmsKeyId: row.valueKmsKeyId,
      wrappedDek: row.valueWrappedDek,
    })
  }

  return variables
}

/**
 * The hostname a deployment serves on.
 *
 * `hostLabel` is carried over from the Knative renderer unchanged — it is pure, and the reasoning
 * in it survives the pivot intact: a project slug is unique per organization, not globally, so the
 * label needs a discriminator or two customers with a project called `myapp` collide and the second
 * to deploy takes the first one's traffic.
 */
export function hostnameFor(
  project: { id: string; slug: string; organizationId: string },
  deployment: { kind: string; prNumber: number | null },
): string {
  return `${hostLabel(project, { kind: deployment.kind, prNumber: deployment.prNumber })}.${tenantDomain()}`
}

export function publishRelease(options?: PublishOptions): JobHandler {
  return async (job, { db, keepAlive, signal }) => {
    const clients = options ?? sharedClients()
    const { deploymentId } = job.payload as PublishPayload
    const publishSignal = AbortSignal.any([signal, AbortSignal.timeout(4 * 60_000)])

    const found = await fetchDeployment(db).withProject(deploymentId)
    // Deleted between enqueue and run. Nothing to publish and nothing to record it against.
    if (found === undefined) return

    const { deployment, project } = found
    if (deployment.status === "torn_down") return

    return withProjectLock(
      db,
      project.id,
      async () => {
        let compensate = async (): Promise<void> => {}
        let servingModeClaimed = false
        try {
          const currentProject = await db
            .selectFrom("project")
            .select(["id", "deletedAt", "servingMode"])
            .where("id", "=", project.id)
            .executeTakeFirst()
          if (currentProject === undefined || currentProject.deletedAt !== null) return

          const livePointer = await db
            .selectFrom("project")
            .select("liveDeploymentId")
            .where("id", "=", project.id)
            .executeTakeFirst()
          const previousLive =
            livePointer?.liveDeploymentId === null || livePointer?.liveDeploymentId === undefined
              ? undefined
              : await db
                  .selectFrom("deployment")
                  .select(["id", "preset", "staticDigest", "hostname", "lambdaVersion"])
                  .where("id", "=", livePointer.liveDeploymentId)
                  .executeTakeFirst()
          const previousPreview =
            deployment.kind !== "preview" || deployment.prNumber === null
              ? undefined
              : await db
                  .selectFrom("deployment")
                  .select([
                    "id",
                    "preset",
                    "staticDigest",
                    "staticArtifactKey",
                    "hostname",
                    "lambdaVersion",
                  ])
                  .where("projectId", "=", project.id)
                  .where("kind", "=", "preview")
                  .where("prNumber", "=", deployment.prNumber)
                  .where("id", "!=", deploymentId)
                  .where("status", "=", "ready")
                  .orderBy("createdAt", "desc")
                  .executeTakeFirst()
          const previousServing = deployment.kind === "production" ? previousLive : previousPreview
          const retirePreviousPreview = async () => {
            if (previousPreview === undefined) return
            await db.transaction().execute(async (transaction) => {
              await crudDeployment(transaction).update(previousPreview.id, { status: "torn_down" })
              if (previousPreview.preset === "static") {
                await enqueue(transaction, {
                  kind: PUBLISH_KINDS.cleanUpStaticPreview,
                  organizationId: project.organizationId,
                  payload: { deploymentId: previousPreview.id },
                  maxAttempts: 12,
                  idempotencyKey: `${PUBLISH_KINDS.cleanUpStaticPreview}:${previousPreview.id}`,
                })
              }
            })
          }

          const requestedMode = deployment.preset === "static" ? "static" : "serverless"
          const establishedMode =
            currentProject.servingMode ??
            (previousLive === undefined
              ? undefined
              : previousLive.preset === "static"
                ? "static"
                : "serverless")
          if (establishedMode !== undefined && establishedMode !== requestedMode) {
            await crudDeployment(db).update(deploymentId, {
              status: "error",
              failureReason:
                "A project cannot switch between static and serverless serving modes. Create a new " +
                "project for the other serving mode so a failed release cannot strand live traffic.",
            })
            return
          }
          let serverlessTrafficMayHaveMoved = false
          const hostname = hostnameFor(project, deployment)
          const aliasName =
            deployment.kind === "production" ? "live" : `preview-${deployment.prNumber}`
          const restoreServerlessTraffic = async () => {
            if (!serverlessTrafficMayHaveMoved) return
            if (deployment.kind !== "production") {
              if (
                previousPreview?.preset !== "static" &&
                previousPreview?.lambdaVersion !== null &&
                previousPreview?.lambdaVersion !== undefined &&
                previousPreview.hostname !== null
              ) {
                const aliasArn = await pointAlias(
                  clients.lambda,
                  functionName(project.id),
                  previousPreview.lambdaVersion,
                  aliasName,
                )
                await publishRoute(clients.valkey, previousPreview.hostname, {
                  arn: aliasArn,
                  projectId: project.id,
                  organizationId: project.organizationId,
                  deploymentId: previousPreview.id,
                })
                await crudDeployment(db).update(previousPreview.id, { status: "ready" })
                return
              }
              try {
                await clients.lambda.send(
                  new DeleteAliasCommand({
                    FunctionName: functionName(project.id),
                    Name: aliasName,
                  }),
                )
              } catch (error) {
                if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
                  throw error
              }
              await withdrawRoute(clients.valkey, hostname)
              return
            }
            const domains = await db
              .selectFrom("customDomain")
              .select("hostname")
              .where("projectId", "=", project.id)
              .where("status", "=", "active")
              .where("deletedAt", "is", null)
              .execute()
            if (
              previousLive?.preset !== "static" &&
              previousLive?.lambdaVersion !== null &&
              previousLive?.lambdaVersion !== undefined &&
              previousLive.hostname !== null
            ) {
              const aliasArn = await pointAlias(
                clients.lambda,
                functionName(project.id),
                previousLive.lambdaVersion,
              )
              const route: Route = {
                arn: aliasArn,
                projectId: project.id,
                organizationId: project.organizationId,
                deploymentId: previousLive.id,
              }
              await publishRoute(clients.valkey, previousLive.hostname, route)
              for (const domain of domains)
                await publishRoute(clients.valkey, domain.hostname, route)
              await publishLiveDeployment(clients.valkey, project.id, previousLive.id)
              await db
                .updateTable("project")
                .set({ liveDeploymentId: previousLive.id, updatedAt: new Date() })
                .where("id", "=", project.id)
                .execute()
              return
            }

            try {
              await clients.lambda.send(
                new DeleteAliasCommand({ FunctionName: functionName(project.id), Name: aliasName }),
              )
            } catch (error) {
              if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
                throw error
            }
            await withdrawRoute(clients.valkey, hostname)
            for (const domain of domains) await withdrawRoute(clients.valkey, domain.hostname)
            await clients.valkey.del(`live:${project.id}`)
            await db
              .updateTable("project")
              .set({ liveDeploymentId: null, updatedAt: new Date() })
              .where("id", "=", project.id)
              .execute()
          }
          compensate = restoreServerlessTraffic

          if (deployment.preset !== "static" && deployment.artifactKey === null) {
            // The release was recorded but the upload never landed. Not retried: the artifact is uploaded
            // *before* the release call, so an absent key means the action did something we do not
            // understand, and retrying will not make bytes appear.
            await crudDeployment(db).update(deploymentId, {
              status: "error",
              failureReason: "No build artifact was uploaded for this release",
            })
            return
          }

          /*
      Config files have no home on Lambda.

      A Knative deployment mounted them from a Secret. A Lambda's filesystem is the contents of its
      zip plus a writable `/tmp`, so a file the customer expects at `/app/config/x.yml` has to be in
      the archive the build produced — the platform cannot put it there afterwards.

      Said out loud, in the row, rather than dropped. A project whose configuration silently stopped
      being delivered looks to its owner exactly like the application being broken, and this
      repository has already shipped one deployment path where the environment went nowhere.
    */
          const files = await fetchProjectFile(db).listSealedForProject(project.id, deployment.kind)
          if (files.length > 0) {
            await crudDeployment(db).update(deploymentId, {
              status: "error",
              failureReason:
                `This project has ${files.length} configuration file(s), which cannot be delivered to a ` +
                `serverless deployment. Commit them to the repository so the build includes them.`,
            })
            return
          }

          let staticArchive: { artifactKey: string; digest: string } | undefined
          if (deployment.preset === "static") {
            if (deployment.staticArtifactKey === null || deployment.staticDigest === null) {
              await crudDeployment(db).update(deploymentId, {
                status: "error",
                failureReason:
                  "The static release has no complete static archive. Re-run the deploy action so it " +
                  "uploads both the archive and its digest.",
              })
              return
            }
            staticArchive = {
              artifactKey: deployment.staticArtifactKey,
              digest: deployment.staticDigest,
            }
          }

          await crudDeployment(db).update(deploymentId, { status: "deploying" })

          if (deployment.preset === "static") {
            if (staticArchive === undefined)
              throw new Error("Static archive validation was skipped")
            const config = options?.static
            const staticClients = config ?? sharedClients().static
            const bucket = config?.bucket ?? process.env.TENANT_STATIC_BUCKET
            const tenantZoneId = config?.tenantZoneId ?? process.env.TENANT_ZONE_ID
            const distributionDomain =
              config?.distributionDomain ?? process.env.TENANT_STATIC_DISTRIBUTION_DOMAIN
            const keyValueStoreArn =
              config?.keyValueStoreArn ?? process.env.TENANT_STATIC_KEY_VALUE_STORE_ARN
            if (
              bucket === undefined ||
              tenantZoneId === undefined ||
              distributionDomain === undefined ||
              keyValueStoreArn === undefined
            ) {
              await crudDeployment(db).update(deploymentId, {
                status: "error",
                failureReason:
                  "Static serving is not configured on the platform. TENANT_STATIC_BUCKET, " +
                  "TENANT_ZONE_ID, TENANT_STATIC_DISTRIBUTION_DOMAIN, and " +
                  "TENANT_STATIC_KEY_VALUE_STORE_ARN are all required.",
              })
              return
            }

            try {
              await publishStaticSite(staticClients, {
                bucket,
                artifactKey: staticArchive.artifactKey,
                digest: staticArchive.digest,
                projectId: project.id,
                hostname,
                tenantZoneId,
                distributionDomain,
                keyValueStoreArn,
                heartbeat: keepAlive,
                signal: publishSignal,
              })

              if (currentProject.servingMode === null) {
                const claimed = await db
                  .updateTable("project")
                  .set({ servingMode: requestedMode, updatedAt: new Date() })
                  .where("id", "=", project.id)
                  .where("servingMode", "is", null)
                  .executeTakeFirst()
                servingModeClaimed = Number(claimed.numUpdatedRows) > 0
              }
              if (deployment.kind === "production") {
                await publishLiveDeployment(clients.valkey, project.id, deploymentId)
              }
              await crudDeployment(db).update(deploymentId, {
                status: "ready",
                failureReason: null,
                url: `https://${hostname}`,
                hostname,
                lambdaVersion: null,
              })
              if (deployment.kind === "production") {
                await db
                  .updateTable("project")
                  .set({ liveDeploymentId: deploymentId, updatedAt: new Date() })
                  .where("id", "=", project.id)
                  .execute()
              }
              await retirePreviousPreview()
              return
            } catch (error) {
              // Put traffic back where the durable live pointer says it belongs before retrying. This is
              // also safe when activation never happened: both operations are idempotent.
              if (
                previousServing?.preset === "static" &&
                previousServing.staticDigest !== null &&
                previousServing.hostname !== null
              ) {
                await pointStaticSite(staticClients, {
                  hostname: previousServing.hostname,
                  prefix: `${project.id}/${previousServing.staticDigest}`,
                  tenantZoneId,
                  distributionDomain,
                  keyValueStoreArn,
                })
                if (previousServing.hostname !== hostname) {
                  await deactivateStaticHost(staticClients, {
                    hostname,
                    tenantZoneId,
                    keyValueStoreArn,
                  })
                }
                if (previousPreview !== undefined) {
                  await crudDeployment(db).update(previousPreview.id, { status: "ready" })
                }
              } else {
                await deactivateStaticHost(staticClients, {
                  hostname,
                  tenantZoneId,
                  keyValueStoreArn,
                })
              }
              await crudDeployment(db).update(deploymentId, {
                status: "error",
                failureReason: error instanceof Error ? error.message : "Static publication failed",
              })
              throw error
            }
          }

          const environment = await environmentFor(db, project.id, deployment.kind)

          /*
      Migrations, before anything serves.

      `DEPLOYMENT_DOCTRINE` has promised this since it was written — "migrations run as part of the
      deploy, before the new version takes traffic" — and nothing implemented it. Ordered here, not
      after the publish, because the entire value is the ordering: code that ships ahead of its
      schema is the failure this prevents, and running the migration afterwards would prevent
      nothing while looking identical in a log.

      On failure the function is never published and the route is never touched, so the previous
      release keeps serving. That is the same reasoning `publishRoute` follows at the end of this
      handler, applied one step earlier.

      **Not retried.** The job runner would otherwise re-run a partially applied schema change,
      which is how a recoverable failure becomes an unrecoverable one. The deployment is marked
      failed and a human decides.
    */
          const migrationArtifactKey = deployment.migrationArtifactKey
          if (migrationArtifactKey !== null) {
            /*
              Read this state *inside* the project lock.

              The deployment was fetched before waiting for the lock. A worker reclaiming an
              expired lease could otherwise wait behind the original invocation, then act on its
              stale `pending` value and invoke the same migrator again after the first succeeded.
            */
            const migration = await db
              .selectFrom("deployment")
              .select("migrationStatus")
              .where("id", "=", deploymentId)
              .executeTakeFirstOrThrow()

            const migrationAction = migrationResumeAction(migration.migrationStatus)
            if (migrationAction === "stop") return

            if (migrationAction === "ambiguous") {
              await crudDeployment(db).update(deploymentId, {
                status: "error",
                migrationStatus: "failed",
                migrationOutput:
                  "A previous migration attempt ended without a confirmed result. SproutOS did " +
                  "not run it again automatically; inspect the database before starting a new run.",
                migrationFinishedAt: new Date(),
                failureReason:
                  "The migration's result is unknown, so this release was not published and the " +
                  "previous one is still serving.",
              })
              return
            }

            // A worker can die after recording success but before publishing the function. A
            // reclaimed job resumes publication from here without applying the schema twice.
            if (migrationAction === "run") {
              await crudDeployment(db).update(deploymentId, { migrationStatus: "running" })

              let result
              try {
                result = await withLeaseHeartbeat(keepAlive, () =>
                  runMigration(clients.lambda, {
                    projectId: project.id,
                    bucket:
                      options?.bucket ??
                      process.env.SERVICE_BUILD_BUCKET ??
                      "sproutos-dev-artifacts",
                    key: migrationArtifactKey,
                    handler: deployment.migrationHandler ?? deployment.handler ?? DEFAULT_HANDLER,
                    runtime:
                      deployment.runtime !== null && isSupportedRuntime(deployment.runtime)
                        ? deployment.runtime
                        : DEFAULT_RUNTIME,
                    roleArn: options?.roleArn ?? process.env.LAMBDA_EXECUTION_ROLE_ARN ?? "",
                    environment,
                  }),
                )
              } catch (error) {
                const detail =
                  error instanceof Error ? `${error.name}: ${error.message}` : String(error)
                await crudDeployment(db).update(deploymentId, {
                  status: "error",
                  migrationStatus: "failed",
                  migrationOutput:
                    `SproutOS could not confirm the migration result (${detail}). ` +
                    "It was not retried automatically; inspect the database before starting a new run.",
                  migrationFinishedAt: new Date(),
                  failureReason:
                    "The migration's result could not be confirmed, so this release was not " +
                    "published and the previous one is still serving.",
                })
                return
              }

              await crudDeployment(db).update(deploymentId, {
                migrationStatus: result.ok ? "succeeded" : "failed",
                migrationOutput: result.output,
                migrationFinishedAt: new Date(),
              })

              if (!result.ok) {
                await crudDeployment(db).update(deploymentId, {
                  status: "error",
                  failureReason:
                    "The database migration failed, so this release was not published and the previous " +
                    "one is still serving. The migrator's output is on this deployment.",
                })
                return
              }
            }
          }

          /*
      Refuse rather than publish an adapted build without its adapter.

      A function carrying `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` and no `/opt/bootstrap` fails on
      every invocation, and the alias would already have moved by the time anyone saw it. The
      opposite order — publish and hope — is how this subsystem got into a state where every
      deployment in the account was `error` and nothing said which field was missing.
    */
          const adapterLayerArn = deployment.webAdapter
            ? webAdapterLayerArn(process.env.AWS_REGION ?? "us-east-1")
            : undefined
          if (deployment.webAdapter && adapterLayerArn === undefined) {
            await crudDeployment(db).update(deploymentId, {
              status: "error",
              failureReason:
                "This build is a web server and needs the Lambda Web Adapter layer, which is not " +
                "configured. Set LAMBDA_WEB_ADAPTER_LAYER_VERSION on the control plane.",
            })
            return
          }
          const logExtensionLayerArn = logExtensionLayerForProject(project.id)

          serverlessTrafficMayHaveMoved = true
          const published = await publishFunction(clients.lambda, {
            projectId: project.id,
            organizationId: project.organizationId,
            bucket: options?.bucket ?? process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts",
            key: deployment.artifactKey!,
            /*
        From the deployment row, not a constant.

        These were hardcoded, which pinned every customer to one Node version and gave every
        project the same entry point. The row carries what the release asked for; the fallbacks are
        for rows written before the columns existed, and `isSupportedRuntime` guards against a value
        that was valid when it was stored and has since left the allowlist — Lambda would reject it
        anyway, and doing so here says which field was wrong.
      */
            handler: deployment.handler ?? DEFAULT_HANDLER,
            runtime:
              deployment.runtime !== null && isSupportedRuntime(deployment.runtime)
                ? deployment.runtime
                : DEFAULT_RUNTIME,
            memoryMb: deployment.memoryMb > 0 ? deployment.memoryMb : DEFAULT_MEMORY_MB,
            timeoutS: deployment.maxDurationS > 0 ? deployment.maxDurationS : DEFAULT_TIMEOUT_S,
            roleArn: options?.roleArn ?? process.env.LAMBDA_EXECUTION_ROLE_ARN ?? "",
            environment: { ...environment, SPROUTOS_DEPLOYMENT_ID: deploymentId },
            aliasName,
            // Default off and canaryable by project. A layer is embedded in an immutable Lambda
            // version, so a global mistake cannot be undone by flipping an environment variable;
            // the affected customer functions would all have to be republished without it.
            ...(logExtensionLayerArn === undefined ? {} : { logExtensionLayerArn }),
            ...(adapterLayerArn === undefined ? {} : { webAdapterLayerArn: adapterLayerArn }),
          })

          /*
      The route last.

      Publishing it before the function exists would send live traffic at an ARN that resolves to
      nothing, and the router cannot tell that from a customer application returning 502. The
      ordering is the only thing making a deploy atomic from a visitor's point of view: until this
      write lands, the previous release is still serving.
    */
          const route: Route = {
            arn: published.aliasArn,
            projectId: project.id,
            organizationId: project.organizationId,
            deploymentId,
          }
          await publishRoute(clients.valkey, hostname, route)

          /*
      And every custom domain pointing at this project.

      A customer's own hostname is not derived from the project — it is a row they added and
      verified — so it has to be published explicitly, and republished on every release because the
      route carries the deployment's ARN. Skipping this would leave the custom domain resolving to
      the *previous* release indefinitely, which is worse than it not working: the site would be up,
      serving code from whenever the domain was last attached, and nothing would look broken.

      Only `active` domains. A pending one has not proved it controls the zone yet, and publishing a
      route for it would let anyone claim a hostname by typing it into a form.
    */
          if (deployment.kind === "production") {
            const domains = await db
              .selectFrom("customDomain")
              .select("hostname")
              .where("projectId", "=", project.id)
              .where("status", "=", "active")
              .where("deletedAt", "is", null)
              .execute()

            for (const domain of domains) {
              // eslint-disable-next-line no-await-in-loop -- a project has a handful of domains.
              await publishRoute(clients.valkey, domain.hostname, route)
            }

            await publishLiveDeployment(clients.valkey, project.id, deploymentId)
          }

          if (currentProject.servingMode === null) {
            const claimed = await db
              .updateTable("project")
              .set({ servingMode: requestedMode, updatedAt: new Date() })
              .where("id", "=", project.id)
              .where("servingMode", "is", null)
              .executeTakeFirst()
            servingModeClaimed = Number(claimed.numUpdatedRows) > 0
          }

          await crudDeployment(db).update(deploymentId, {
            status: "ready",
            url: `https://${hostname}`,
            hostname,
            lambdaVersion: published.version,
          })

          /*
      And durably, on the project.

      `publishLiveDeployment` above writes `live:<project id>` into Valkey with a 24-hour expiry,
      which is a cache and cannot answer "what is serving right now" for a screen or for a rollback
      — the key may simply be gone. Production only: a preview is a real deployment at a real
      hostname, and pointing the project's live deployment at one would make a pull request look
      like the thing customers are hitting.
    */
          if (deployment.kind === "production") {
            await db
              .updateTable("project")
              .set({ liveDeploymentId: deploymentId, updatedAt: new Date() })
              .where("id", "=", project.id)
              .execute()
          }
          await retirePreviousPreview()
        } catch (error) {
          await compensate()
          if (servingModeClaimed) {
            await db
              .updateTable("project")
              .set({ servingMode: null, updatedAt: new Date() })
              .where("id", "=", project.id)
              .execute()
          }
          await crudDeployment(db).update(deploymentId, {
            status: "error",
            failureReason: error instanceof Error ? error.message : "Deployment publication failed",
          })
          throw error
        }
      },
      { keepAlive },
    )
  }
}

export function tearDownPreview(options?: PublishOptions): JobHandler {
  return async (job, { db, keepAlive }) => {
    const { deploymentId } = job.payload as PublishPayload
    const found = await fetchDeployment(db).withProject(deploymentId)
    if (found === undefined) return
    const { deployment, project } = found
    if (deployment.kind !== "preview" || deployment.status === "torn_down") return

    return withProjectLock(
      db,
      project.id,
      async () => {
        const current = await fetchDeployment(db).withProject(deploymentId)
        if (current === undefined || current.deployment.status === "torn_down") return
        const hostname = current.deployment.hostname
        if (hostname !== null) {
          if (current.deployment.preset === "static") {
            if (
              current.deployment.staticDigest === null ||
              current.deployment.staticArtifactKey === null
            ) {
              throw new Error(`Static preview ${deploymentId} has no retained archive identity`)
            }
            const platform = options?.static ?? staticPlatformFromEnv()
            await removeStaticDeployment(platform, {
              bucket: platform.bucket,
              projectId: project.id,
              digest: current.deployment.staticDigest,
              artifactKey: current.deployment.staticArtifactKey,
              hostnames: [hostname],
              tenantZoneId: platform.tenantZoneId,
              keyValueStoreArn: platform.keyValueStoreArn,
            })
          } else {
            const clients = options ?? sharedClients()
            try {
              await clients.lambda.send(
                new DeleteAliasCommand({
                  FunctionName: functionName(project.id),
                  Name: `preview-${current.deployment.prNumber}`,
                }),
              )
            } catch (error) {
              if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
                throw error
            }
            await withdrawRoute(clients.valkey, hostname)
          }
        }
        await crudDeployment(db).update(deploymentId, { status: "torn_down" })
      },
      { keepAlive },
    )
  }
}

export function cleanUpStaticPreview(options?: PublishOptions): JobHandler {
  return async (job, { db, keepAlive }) => {
    const { deploymentId } = job.payload as PublishPayload
    const found = await fetchDeployment(db).withProject(deploymentId)
    if (found === undefined) return
    return withProjectLock(
      db,
      found.project.id,
      async () => {
        const current = await fetchDeployment(db).withProject(deploymentId)
        if (
          current === undefined ||
          current.deployment.kind !== "preview" ||
          current.deployment.preset !== "static" ||
          current.deployment.staticDigest === null ||
          current.deployment.staticArtifactKey === null
        ) {
          return
        }
        const stillUsed = await db
          .selectFrom("deployment")
          .select("id")
          .where("projectId", "=", current.project.id)
          .where("id", "!=", deploymentId)
          .where("status", "in", ["queued", "building", "deploying", "ready"])
          .where((expression) =>
            expression.or([
              expression("staticDigest", "=", current.deployment.staticDigest),
              expression("staticArtifactKey", "=", current.deployment.staticArtifactKey),
            ]),
          )
          .executeTakeFirst()
        if (stillUsed !== undefined) {
          throw new Error(
            `Static preview bytes are still referenced by nonterminal deployment ${stillUsed.id}`,
          )
        }

        const platform = options?.static ?? staticPlatformFromEnv()
        await removeStaticDeploymentBytes(platform.s3, {
          bucket: platform.bucket,
          projectId: current.project.id,
          digest: current.deployment.staticDigest,
          artifactKey: current.deployment.staticArtifactKey,
        })
      },
      { keepAlive },
    )
  }
}
