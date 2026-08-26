import { LambdaClient } from "@aws-sdk/client-lambda"
import { crudDeployment, fetchDeployment, fetchProjectEnvVar, fetchProjectFile } from "@lib/dao"
import { openEnvVarValue } from "@lib/envelope"
import {
  DEFAULT_HANDLER,
  DEFAULT_RUNTIME,
  hostLabel,
  isSupportedRuntime,
  publishFunction,
  publishLiveDeployment,
  publishRoute,
  type Route,
} from "@lib/lambda"
import type { DB } from "@sproutos/db"
import { Redis } from "ioredis"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"

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
} as const

type PublishPayload = { deploymentId: string }

/** The domain tenant applications are served from. */
function tenantDomain(): string {
  return process.env.TENANT_DOMAIN ?? "sproutos.me"
}

/** Lambda's own defaults for a project that has not chosen. */
const DEFAULT_MEMORY_MB = 512
const DEFAULT_TIMEOUT_S = 30

export type PublishOptions = {
  lambda: LambdaClient
  valkey: Redis
  bucket?: string
  roleArn?: string
}

/*
  Clients built on first use, never at import.

  `PLATFORM_HANDLERS` is a module-scope object literal, so anything constructed inside it runs when
  the module loads. A `new Redis(...)` there opens a connection as a side effect of importing the
  handler registry — which kept the OpenAPI generator's process alive until it timed out at three
  minutes, and would keep a CLI or a migration alive the same way.
*/
let shared: { lambda: LambdaClient; valkey: Redis } | undefined
function sharedClients(): { lambda: LambdaClient; valkey: Redis } {
  shared ??= {
    lambda: new LambdaClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(process.env.AWS_ENDPOINT_URL === undefined
        ? {}
        : { endpoint: process.env.AWS_ENDPOINT_URL }),
    }),
    // The platform's own Valkey, where the route map lives — not the tenant instance.
    valkey: new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023"),
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
  return async (job, { db }) => {
    const clients = options ?? sharedClients()
    const { deploymentId } = job.payload as PublishPayload

    const found = await fetchDeployment(db).withProject(deploymentId)
    // Deleted between enqueue and run. Nothing to publish and nothing to record it against.
    if (found === undefined) return

    const { deployment, project } = found
    if (deployment.status === "torn_down") return

    if (deployment.artifactKey === null) {
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

    await crudDeployment(db).update(deploymentId, { status: "deploying" })

    const environment = await environmentFor(db, project.id, deployment.kind)
    const hostname = hostnameFor(project, deployment)

    const published = await publishFunction(clients.lambda, {
      projectId: project.id,
      bucket: options?.bucket ?? process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts",
      key: deployment.artifactKey,
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
      // Unset in development, where there is no layer to attach and no Kafka to ship to. A
      // deployment without it runs and produces no logs, which is why it is set from one place.
      ...(process.env.LOG_EXTENSION_LAYER_ARN === undefined
        ? {}
        : { logExtensionLayerArn: process.env.LOG_EXTENSION_LAYER_ARN }),
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
    // And by project id, which is the only thing the log shipper has: a CloudWatch log group is
    // named after the project, never after the hostname.
    await publishLiveDeployment(clients.valkey, project.id, deploymentId)

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
  }
}
