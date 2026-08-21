import { crudAuditLog, crudDeployment, crudProjectJob, crudSandbox } from "@lib/dao"
import {
  secretPath,
  createKubeClient,
  inClusterConfig,
  knativeServicePath,
  workerName,
  workerPath,
} from "@lib/deploy"
import { podPath } from "@lib/sandbox"
import {
  sproutPostgresConfigFromEnv,
  sproutPostgresDriver,
  searchDriver,
  searchServiceConfigFromEnv,
  valkeyDriver,
  valkeyServiceConfigFromEnv,
} from "@lib/services"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { tenantNamespace } from "./deploy"
import type { JobHandler } from "./worker"

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
 * `RETAINED_ON_DELETE` in the route — `usage_event`, `usage_rollup`, `statement_line_item`,
 * `audit_log` — and this job honours that. Those reference `project` with `ON DELETE RESTRICT` on
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
 * The Kubernetes surface this needs: look something up, and delete it.
 *
 * Injected rather than constructed from a config, matching `runInSandbox`. A config still builds a
 * client that makes real connections, so a test passing one reaches the network — which is how this
 * signature started and why it changed.
 */
export type TeardownKube = Pick<
  ReturnType<typeof createKubeClient>,
  "get" | "remove" | "removeCollection"
>

export function tearDownProject(kubeClient?: TeardownKube): JobHandler {
  return async (job, { db }) => {
    const { projectId, projectJobId } = job.payload as {
      projectId?: string
      projectJobId?: string
    }
    if (projectId === undefined) throw new Error("project.teardown needs a projectId")

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

    const namespace = tenantNamespace(project.organizationId)
    // Built here, not at registration: `inClusterConfig` reads a service-account token that only
    // exists inside a pod, and evaluating it at import time would stop the worker starting anywhere
    // else.
    const kube = kubeClient ?? createKubeClient(inClusterConfig())
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
      .select(["id", "kind", "prNumber"])
      .where("projectId", "=", projectId)
      .where("status", "!=", "torn_down")
      .execute()

    for (const deployment of deployments) {
      await removeQuietly(
        kube,
        knativeServicePath(namespace, revisionName(project.slug, deployment)),
      )
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
      await driverFor(db, service.kind).destroy(service.id)
      result.services += 1

      // The worker the dispatcher may have started for this queue. Named from the project and the
      // queue, and the queue is gone with the service — so every worker for this project goes.
      if (service.kind === "valkey")
        result.workers += await removeWorkers(kube, namespace, projectId, db)
    }

    // Dev sandboxes: a pod per user, each holding a node until its idle timeout.
    const sandboxes = await db
      .selectFrom("sandbox")
      .select(["id", "podName", "namespace"])
      .where("projectId", "=", projectId)
      .execute()

    for (const sandbox of sandboxes) {
      if (sandbox.podName !== null) {
        await removeQuietly(kube, podPath(sandbox.namespace ?? namespace, sandbox.podName))
      }
      await crudSandbox(db).update(sandbox.id, { state: "stopped", podName: null })
      result.sandboxes += 1
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
      And the same values in the cluster, which the database delete does not reach.

      A revision's environment is a Kubernetes Secret named after its own contents, so a project
      accumulates one per environment it has ever deployed with — there is no list of names to walk,
      which is why this goes by label. Deleting the rows and leaving these behind would mean a
      customer who asked the platform to stop holding their data, and was told it had, while their
      decrypted API keys sat in a namespace indefinitely.
    */
    await kube.removeCollection(secretPath(namespace, ""), `sproutos.dev/project=${projectId}`)

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
  }
}

/**
 * Delete something, treating "it is not there" as success.
 *
 * A teardown is retried, and the second run finds most of its work already done. Distinguishing
 * "deleted it" from "it was already gone" would make a retry fail for having succeeded.
 */
async function removeQuietly(kube: TeardownKube, path: string): Promise<void> {
  if ((await kube.get(path)) === undefined) return
  await kube.remove(path)
}

/** Every queue worker this project has. */
async function removeWorkers(
  kube: TeardownKube,
  namespace: string,
  projectId: string,
  db: Kysely<DB>,
): Promise<number> {
  const queues = await db
    .selectFrom("workflow")
    .select(["name"])
    .where("projectId", "=", projectId)
    .execute()

  let removed = 0
  for (const queue of queues) {
    const path = workerPath(namespace, workerName(projectId, queue.name))
    if ((await kube.get(path)) === undefined) continue
    await kube.remove(path)
    removed += 1
  }
  return removed
}

/** The Knative service name for one deployment. Mirrors `hostLabel`. */
function revisionName(slug: string, deployment: { kind: string; prNumber: number | null }): string {
  const suffix =
    deployment.kind === "preview" && deployment.prNumber !== null
      ? `-pr-${deployment.prNumber}`
      : ""
  return `${slug}${suffix}`
}

function driverFor(db: Kysely<DB>, kind: string) {
  if (kind === "postgres") return sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
  if (kind === "valkey") return valkeyDriver(db, valkeyServiceConfigFromEnv())
  if (kind === "elasticsearch") return searchDriver(db, searchServiceConfigFromEnv())
  throw new Error(`No driver for backend service kind "${kind}"`)
}
