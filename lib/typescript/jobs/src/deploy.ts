import { crudDeployment, fetchDeployment } from "@lib/dao"
import {
  createKubeClient,
  inClusterConfig,
  type KnativeService,
  knativeService,
  knativeServicePath,
  type KubeConfig,
} from "@lib/deploy"
import { ensureTenantNamespace } from "@lib/sandbox"
import { BUILD_KINDS } from "./build"
import { enqueue } from "./queue"
import { sleep } from "./sleep"
import type { JobHandler } from "./worker"

export const DEPLOY_KINDS = {
  revision: "deploy.revision",
} as const

type DeployPayload = { deploymentId: string }

/** How long to wait for a revision before handing the wait back to the queue. */
const READY_BUDGET_MS = 90_000
const POLL_INTERVAL_MS = 5_000

/** Knative's own condition vocabulary, narrowed to what the status decision reads. */
type ServiceStatus = {
  status?: {
    url?: string
    latestReadyRevisionName?: string
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[]
  }
}

export type RevisionOutcome =
  | { state: "ready" }
  | { state: "progressing" }
  | { state: "failed"; message: string }

/**
 * What a Knative Service's conditions mean, which is not what they appear to mean.
 *
 * The top-level `Ready` condition goes **`False` with reason `RevisionMissing` while a first deploy
 * is still coming up** — the same value, reason and message it carries when the revision has failed
 * outright. Reading `Ready: False` as a failure marks every healthy deployment as errored within a
 * second or two of being created; the first version of this handler did exactly that, and the test
 * against a real cluster is what caught it.
 *
 * The terminal signal is `ConfigurationsReady` with reason `RevisionFailed`. That one is only set
 * once Knative has given up — a pull that will not succeed, or a scale that was never achieved —
 * and its message is the one worth showing a customer, because the `Ready` message says only that
 * there is no ready revision, which they can see.
 */
export function revisionOutcome(service: ServiceStatus): RevisionOutcome {
  const conditions = service.status?.conditions ?? []
  const ready = conditions.find((condition) => condition.type === "Ready")

  if (ready?.status === "True") return { state: "ready" }

  const configuration = conditions.find((condition) => condition.type === "ConfigurationsReady")

  if (configuration?.status === "False" && configuration.reason === "RevisionFailed") {
    return { state: "failed", message: configuration.message ?? "no message" }
  }

  return { state: "progressing" }
}

/**
 * Turn one `deployment` row into a running Knative Service.
 *
 * The apply is server-side and idempotent, which is what makes this safe to retry: a first deploy
 * and a redeploy are the same call, and deciding between create and update by reading first would
 * race every other actor in the cluster.
 *
 * **The wait is bounded and then handed back to the queue.** A revision that is pulling a large
 * image can take many minutes, and a handler that blocks for all of it holds a worker slot and a
 * lease the whole time — so a slow deploy would stop unrelated work, and a lease expiring mid-wait
 * would have the job reclaimed and applied again from the top. Polling for a bounded budget covers
 * the common case in one pass; anything slower re-enqueues and costs nothing while it waits.
 */
export function deployRevision(config?: KubeConfig): JobHandler {
  return async (job, { db, keepAlive, signal }) => {
    const { deploymentId } = job.payload as DeployPayload

    const found = await fetchDeployment(db).withProject(deploymentId)
    // Deleted between enqueue and run. Not an error: there is nothing to deploy and nothing to
    // record it against.
    if (found === undefined) return

    const { deployment, project } = found

    /*
      No image yet, so start the build. This is the link the pipeline was missing.

      The comment that used to be here said the absence of an image "means the build has not
      finished rather than that anything is wrong" — and it was right about the meaning and wrong
      about the fact. **Nothing ever enqueued a build.** `buildImage` was written, registered in
      `PLATFORM_HANDLERS`, and only ever enqueued *by itself*, as a recheck of a build already
      running. The first one had no origin.

      So `POST /deployments` created a row, enqueued `deployRevision`, and this branch marked it
      `building` and returned. It stayed `building` forever. No project this platform has ever
      forked could deploy — which is the product.

      The other half of the loop was already here: when a build finishes it enqueues
      `DEPLOY_KINDS.revision` for the same deployment, and this handler runs again with an image.
      Keyed on the deployment so a redeploy of something already building joins the build in flight
      rather than starting a second one.
    */
    if (deployment.imageUri === null) {
      await crudDeployment(db).update(deploymentId, { status: "building" })
      await enqueue(db, {
        kind: BUILD_KINDS.image,
        organizationId: project.organizationId,
        payload: { deploymentId },
        idempotencyKey: `${BUILD_KINDS.image}:${deploymentId}`,
      })
      return
    }

    if (deployment.status === "torn_down") return

    const namespace = tenantNamespace(project.organizationId)
    const service = knativeService(
      { id: project.id, slug: project.slug, organizationId: project.organizationId },
      {
        kind: deployment.kind,
        prNumber: deployment.prNumber,
        imageUri: deployment.imageUri,
        runtimeClass: deployment.runtimeClass,
        scaleMode: deployment.scaleMode === "warm" ? "warm" : "cold",
        containerConcurrency: deployment.containerConcurrency,
        memoryMb: deployment.memoryMb,
        maxDurationS: deployment.maxDurationS,
      },
      namespace,
    )

    const kube = createKubeClient(config ?? inClusterConfig())
    const path = knativeServicePath(namespace, service.metadata.name)

    // The namespace and its NetworkPolicies first — a deployed revision is customer code too, and
    // it reaches the network far more than a workflow node does.
    await ensureTenantNamespace(kube, namespace)

    await kube.apply<KnativeService>(path, service)
    await crudDeployment(db).update(deploymentId, { status: "deploying" })

    const deadline = Date.now() + READY_BUDGET_MS

    while (Date.now() < deadline) {
      // If the lease has been taken away, something else already owns this job — stop touching the
      // row rather than racing the worker that reclaimed it.
      if (!(await keepAlive())) return

      const current = await kube.get<ServiceStatus>(path)
      const outcome =
        current === undefined ? { state: "progressing" as const } : revisionOutcome(current)

      if (outcome.state === "ready") {
        await crudDeployment(db).update(deploymentId, {
          status: "ready",
          url: current?.status?.url ?? null,
          knativeRevision: current?.status?.latestReadyRevisionName ?? null,
        })
        return
      }

      if (outcome.state === "failed") {
        /*
          A revision Knative has given up on does not become ready by being asked again.

          The message is written to the row, not only thrown. This comment used to say "recorded as
          an error so the customer sees Knative's own message" and the message went into the thrown
          error, which reaches `background_job.last_error` and stops there — a table no customer can
          read. What they saw was `status: error` and nothing else.

          It is worth reading. The first real one on this platform was `parsing config: reading
          /app/config/glance.yml: no such file or directory` — not a platform fault, and exactly
          what the person who forked the application needs in order to know the problem is theirs.
        */
        await crudDeployment(db).update(deploymentId, {
          status: "error",
          failureReason: outcome.message.slice(0, 4000),
        })
        throw new Error(`Revision failed: ${outcome.message}`)
      }

      await sleep(POLL_INTERVAL_MS, signal)
    }

    // Still coming up. Hand the wait back rather than holding a worker for it.
    await enqueue(db, {
      kind: DEPLOY_KINDS.revision,
      organizationId: project.organizationId,
      payload: { deploymentId },
      runAt: new Date(Date.now() + POLL_INTERVAL_MS * 4),
      // Keyed on the attempt, so each re-check enqueues exactly once but a later one is not
      // swallowed by the key of an earlier one.
      idempotencyKey: `${DEPLOY_KINDS.revision}:${deploymentId}:${job.attempt}:recheck`,
    })
  }
}

/**
 * One namespace per organization.
 *
 * Derived rather than stored: the control plane creates the namespace from the same function, so
 * there is no second place for the two to disagree. The organization id is a UUID, which is a valid
 * DNS label once the dashes are gone and it is prefixed — a label may not begin with a digit.
 */
export function tenantNamespace(organizationId: string): string {
  return `tenant-${organizationId.replaceAll("-", "")}`
}
