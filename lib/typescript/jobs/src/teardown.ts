import { crudAuditLog, crudDeployment, crudProjectJob, crudSandbox } from "@lib/dao"
import { daytonaClientFromEnv, SandboxNotFoundError } from "@lib/sandbox"
import { LambdaClient } from "@aws-sdk/client-lambda"
import { CloudFrontKeyValueStoreClient } from "@aws-sdk/client-cloudfront-keyvaluestore"
import { Route53Client } from "@aws-sdk/client-route-53"
import { S3Client } from "@aws-sdk/client-s3"
import { tearDownDeployment } from "@lib/lambda"
import { Redis } from "ioredis"
import {
  neonPostgresDriverFromEnv,
  sproutPostgresConfigFromEnv,
  sproutPostgresDriver,
  searchDriver,
  searchServiceConfigFromEnv,
  valkeyDriver,
  valkeyServiceConfigFromEnv,
} from "@lib/services"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"
import { removeStaticSite, type StaticPublisherClients } from "./static-publish"
import { withProjectLock } from "./project-lock"

/**
 * Destroy what a deleted project left running.
 *
 * ## The promise this keeps
 *
 * `DELETE /orgs/:slug/projects/:id` is described as "Soft-deletes a project and queues its
 * teardown", tells the customer in its response body that "a teardown job is queued", and returns
 * `scheduledForTeardown` naming nine kinds of resource. There was no teardown job. `JOB_KINDS` had
 * no such kind, nothing enqueued one, and the only two places that mention `torn_down` *read* that
 * status — nothing has ever written it.
 *
 * So deleting a project soft-deleted a row and left everything running. The Knative service went on
 * serving traffic and billing; the dev sandbox pod went on holding a node; the backend services
 * stayed provisioned with live credentials; the environment variables, which are the customer's
 * secrets, stayed in the database. The customer was told all of it had been scheduled for
 * destruction.
 *
 * ## What it does not touch
 *
 * `RETAINED_ON_DELETE` in the route — `usage_rollup`, `statement_line_item`, `audit_log` — and this
 * job honours that. Those reference `project` with `ON DELETE RESTRICT` on
 * purpose (ADR 0017): last month's statement has to resolve its line items to a named project, so a
 * deletion must not take the evidence behind a bill with it. The project row is marked, not removed.
 *
 * ## Idempotent, because a job is retried
 *
 * Every step tolerates having been done already: a Kubernetes delete of something absent is a 404
 * this ignores, `destroy` on a service already destroyed is a no-op, and the row updates are
 * assignments rather than decrements. A teardown that failed halfway must be safe to run again,
 * because the alternative is a half-destroyed project nobody dares retry.
 */

/** The job kind. Mirrored in `JOB_KINDS`. */
export const TEARDOWN_KIND = "project.teardown"

export type TeardownResult = {
  deployments: number
  services: number
  sandboxes: number
  workers: number
  envVars: number
}

/**
 * What this needs to take a project's compute away: Lambda, and the platform Valkey holding routes.
 *
 * Injected rather than built from the environment, because a default that constructs real clients
 * means a unit test opens a Redis connection it never closes and reaches AWS without saying so.
 * The Kubernetes client this replaced was injected for the same reason.
 */
export type TeardownClients = {
  lambda: LambdaClient
  valkey: Redis
  static?: StaticPublisherClients & {
    bucket: string
    tenantZoneId: string
    keyValueStoreArn: string
  }
}

export function tearDownProject(clients?: TeardownClients): JobHandler {
  return async (job, { db, keepAlive, signal }) => {
    const { projectId, projectJobId } = job.payload as {
      projectId?: string
      projectJobId?: string
    }
    if (projectId === undefined) throw new Error("project.teardown needs a projectId")

    return withProjectLock(
      db,
      projectId,
      async () => {
        const ownLease = async () => {
          signal?.throwIfAborted()
          if (!(await keepAlive())) throw new Error("Lost ownership of the project teardown job")
        }
        await ownLease()
        /*
      The `project_job` row the delete route created, driven to completion here.

      `provisionProject.remove` writes one with `kind: "delete"`, the route returns it, and the
      dashboard polls it — and `provision.ts` only ever handled `fork` and `create`, so it sat at
      `queued` forever. A customer watching their deletion would have watched it not happen.
    */
        if (projectJobId !== undefined) {
          await crudProjectJob(db).update(projectJobId, { state: "running", startedAt: new Date() })
        }

        const project = await db
          .selectFrom("project")
          .select(["id", "slug", "organizationId", "deletedAt"])
          .where("id", "=", projectId)
          .executeTakeFirst()

        // Gone entirely, or never existed. Nothing to tear down and nothing to report.
        if (project === undefined) return

        /*
      Refuses to tear down a project that is not deleted.

      A teardown enqueued for a live project would destroy a customer's running site, and the only
      thing standing between the two is a payload field. This is the check that makes an
      accidentally-enqueued job harmless instead of catastrophic.
    */
        if (project.deletedAt === null) {
          throw new Error(`Project ${projectId} is not deleted; refusing to tear it down`)
        }

        // Built here, not at registration: constructing clients at import time makes a worker fail to
        // start wherever the environment is incomplete.
        const awsConfig = {
          region: process.env.AWS_REGION ?? "us-east-1",
          ...(process.env.AWS_ENDPOINT_URL === undefined
            ? {}
            : { endpoint: process.env.AWS_ENDPOINT_URL }),
        }
        const aws: TeardownClients = clients ?? {
          lambda: new LambdaClient(awsConfig),
          valkey: new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023"),
        }
        const result: TeardownResult = {
          deployments: 0,
          services: 0,
          sandboxes: 0,
          workers: 0,
          envVars: 0,
        }

        /*
      Deployments first. This is the one that costs money every minute it is skipped, and the one a
      customer would notice: a deleted project whose site still answers.
    */
        const deployments = await db
          .selectFrom("deployment")
          .select(["id", "kind", "prNumber", "hostname", "preset"])
          .where("projectId", "=", projectId)
          .where("status", "!=", "torn_down")
          .execute()

        const staticDeployments = deployments.filter(({ preset }) => preset === "static")
        if (staticDeployments.length > 0) {
          await ownLease()
          const staticClients = aws.static
          const bucket = staticClients?.bucket ?? process.env.TENANT_STATIC_BUCKET
          const tenantZoneId = staticClients?.tenantZoneId ?? process.env.TENANT_ZONE_ID
          const keyValueStoreArn =
            staticClients?.keyValueStoreArn ?? process.env.TENANT_STATIC_KEY_VALUE_STORE_ARN
          if (
            bucket === undefined ||
            tenantZoneId === undefined ||
            keyValueStoreArn === undefined
          ) {
            throw new Error(
              "Static teardown needs TENANT_STATIC_BUCKET, TENANT_ZONE_ID, and " +
                "TENANT_STATIC_KEY_VALUE_STORE_ARN",
            )
          }
          const sharedStatic =
            staticClients ??
            ({
              s3: new S3Client({
                ...awsConfig,
                forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined,
              }),
              route53: new Route53Client(awsConfig),
              keyValueStore: new CloudFrontKeyValueStoreClient({ region: "us-east-1" }),
              bucket,
              tenantZoneId,
              keyValueStoreArn,
            } satisfies NonNullable<TeardownClients["static"]>)

          await removeStaticSite(sharedStatic, {
            bucket,
            projectId,
            hostnames: staticDeployments.flatMap(({ hostname }) =>
              hostname === null ? [] : [hostname],
            ),
            tenantZoneId,
            keyValueStoreArn,
          })
        }

        for (const deployment of deployments) {
          await ownLease()
          /*
        The route first, then the function — the reverse of publishing.

        A release publishes the function and then the route, so traffic never points at nothing.
        Teardown reverses it so nothing points at the function when it goes; the other order leaves
        a window where the router resolves a host to an ARN that has gone, and every request in it
        is a 502 rather than the 404 the project has earned.

        Withdrawn by the hostname stored on the row, not one recomputed from the project: a project
        renamed since it deployed would otherwise keep its old host resolving.
      */
          await tearDownDeployment(aws, { projectId, hostname: deployment.hostname })
          await crudDeployment(db).update(deployment.id, { status: "torn_down" })
          result.deployments += 1
        }

        /*
      Backend services, through their own drivers.

      `destroy` is what revokes the credential, drops the database, and makes the tenant's keys
      unreachable — none of which a `delete from backend_service` would do. A driver whose
      configuration is missing throws, and that failure is the job's: a service left provisioned is
      exactly what this exists to prevent, so it must not pass silently.
    */
        const services = await db
          .selectFrom("backendService")
          .select(["id", "kind"])
          .where("projectId", "=", projectId)
          .where("deletedAt", "is", null)
          .execute()

        for (const service of services) {
          await ownLease()
          /*
        The driver owns the row, not this job.

        `destroy` already sets `status` and `deleted_at` — every driver does, in the same place it
        revokes the credential. The first version of this wrote `status: "deleted"` on top of that,
        which is redundant *and* not a value `backend_service_status_check` permits: the vocabulary
        is `provisioning`, `active`, `suspended`, `deleting`, `error`. So the teardown failed on a
        column update it should never have made, after having correctly destroyed the service.

        Guessing an enum value instead of reading the constraint is the fourth time in this codebase
        — see `sandbox_state_check`, `sandbox_runtime_class_check` and `workflow_run_step_status_check`.
        `services.test.ts` now reads this one out of `pg_constraint`.
      */
          await (await driverFor(db, service.kind, service.id)).destroy(service.id)
          result.services += 1

          // Queue workers were Kubernetes Deployments the dispatcher scaled. The router owns queue
          // dispatch now and starts a Lambda per batch, so there is nothing left running to remove.
        }

        /*
      Dev sandboxes: one rented container per user, billed by the second for as long as it exists.

      The earlier version of this marked the row `stopped` and cleared `pod_name`, which was the
      whole teardown — for a pod, that was at least a lie the cluster would eventually correct. For
      a rented sandbox it is worse than nothing: the row stops saying the sandbox is running while
      the provider goes on charging for it, and the only record of what to cancel is the
      `external_id` this used to leave behind.

      So the provider is told first and the row goes second, in that order: a delete that succeeds
      at the provider and then fails here leaves a row pointing at nothing, which the next run
      treats as already-destroyed. The reverse leaves a paid container nothing references.
    */
        const sandboxes = await db
          .selectFrom("sandbox")
          .select(["id", "externalId"])
          .where("projectId", "=", projectId)
          .execute()

        if (sandboxes.length > 0) {
          const driver = daytonaClientFromEnv()
          for (const sandbox of sandboxes) {
            await ownLease()
            if (sandbox.externalId !== null) {
              try {
                await driver.destroy(sandbox.externalId)
              } catch (error) {
                // Already gone is done. Anything else has to stop the job, because the alternative is
                // deleting our only record of a sandbox that is still running and still billing.
                if (!(error instanceof SandboxNotFoundError)) throw error
              }
            }
            await crudSandbox(db).remove(sandbox.id)
            result.sandboxes += 1
          }
        }

        /*
      Environment variables, deleted rather than soft-deleted.

      These are the customer's secrets — sealed, but sealed with a key the platform holds. Retaining
      them past a deletion is the one thing on this list with no upside: nothing references them,
      no statement resolves through them, and the request that triggered this was a request to stop
      holding the project's data.
    */
        const envVars = await db
          .deleteFrom("projectEnvVar")
          .where("projectId", "=", projectId)
          .executeTakeFirst()
        result.envVars = Number(envVars.numDeletedRows ?? 0)

        /*
      There is no second copy to chase, and that is worth recording rather than leaving as a gap.

      A Knative revision's environment was a Kubernetes Secret named after its own contents, so a
      project accumulated one per environment it had ever deployed with and teardown had to sweep
      them by label. A Lambda's environment lives on the function — so deleting the function deletes
      it, and the function went above, before this line runs.
    */

        await db
          .updateTable("project")
          .set({ state: "deleted", updatedAt: new Date() })
          .where("id", "=", projectId)
          .execute()

        await crudAuditLog(db).record({
          organizationId: project.organizationId,
          actorUserId: null,
          action: "project:delete",
          resourceSrn: `srn:sproutos:compute:${project.organizationId}:project/${projectId}`,
          after: { ...result },
        })

        if (projectJobId !== undefined) {
          await crudProjectJob(db).update(projectJobId, {
            state: "succeeded",
            finishedAt: new Date(),
          })
        }

        console.info(
          `[jobs] tore down project ${project.slug}: ${result.deployments} deployment(s), ` +
            `${result.services} service(s), ${result.sandboxes} sandbox(es), ${result.workers} worker(s), ` +
            `${result.envVars} env var(s)`,
        )
      },
      { keepAlive },
    )
  }
}

async function driverFor(db: Kysely<DB>, kind: string, backendServiceId: string) {
  if (kind === "postgres") {
    /*
      Destruction follows the provider recorded on the database, never today's provisioning flag.

      The old dispatch always constructed the shared-cluster driver. On Neon, giving the worker
      the otherwise-correct public proxy hostname completed that driver's configuration with
      `DATABASE_URL` as its admin connection — the control-plane RDS master connection. A project
      teardown could therefore execute DROP DATABASE/DROP ROLE against the control plane.

      `SERVICE_POSTGRES_PROVIDER` says what a *new* database should be. It cannot answer what an
      existing database was during a migration, so read the durable provider on the instance.
    */
    const instance = await db
      .selectFrom("databaseInstance")
      .select(["provider"])
      .where("backendServiceId", "=", backendServiceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (instance === undefined) {
      throw new Error(`Postgres service ${backendServiceId} has no live database instance`)
    }
    return postgresTeardownDriver(instance.provider, backendServiceId, {
      neon: () => neonPostgresDriverFromEnv(db),
      sprout: () => sproutPostgresDriver(db, sproutPostgresConfigFromEnv()),
    })
  }
  if (kind === "valkey") return valkeyDriver(db, valkeyServiceConfigFromEnv())
  if (kind === "elasticsearch") return searchDriver(db, searchServiceConfigFromEnv())
  throw new Error(`No driver for backend service kind "${kind}"`)
}

/**
 * Resolve the destructive Postgres implementation from durable instance state.
 *
 * Kept as a tiny injectable seam so the safety decision is unit-testable without constructing a
 * real Neon client or opening the shared-cluster administrator connection.
 */
export function postgresTeardownDriver<T>(
  provider: string,
  backendServiceId: string,
  factories: { neon: () => T; sprout: () => T },
): T {
  if (provider === "neon") return factories.neon()
  if (provider === "sprout") return factories.sprout()
  throw new Error(`Postgres service ${backendServiceId} uses unsupported provider "${provider}"`)
}
