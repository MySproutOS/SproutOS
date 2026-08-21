import { crudDeployment, crudDeploymentBuild, fetchDeployment, fetchPlacement } from "@lib/dao"
import {
  type BuildSpec,
  buildJob,
  buildJobName,
  createKubeClient,
  imageUri,
  inClusterConfig,
  type KubeConfig,
} from "@lib/deploy"
import { DEPLOY_KINDS } from "./deploy"
import { enqueue } from "./queue"
import { sleep } from "./sleep"
import type { JobHandler } from "./worker"

export const BUILD_KINDS = {
  image: "deploy.build",
} as const

type BuildPayload = { deploymentId: string }

/** Where builds run. See `deploy/builds/namespace.yaml` for why it is not the tenant's namespace. */
export const BUILD_NAMESPACE = "sproutos-builds"

const WATCH_BUDGET_MS = 120_000
const POLL_INTERVAL_MS = 5_000

type JobStatus = {
  status?: { succeeded?: number; failed?: number; active?: number }
}

function jobPath(namespace: string, name: string): string {
  return `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`
}

export type BuildSettings = {
  registry: string
  insecureRegistry?: boolean
  /** The Secret holding the push credential. See `BuildSpec.registryAuthSecret`. */
  registryAuthSecret?: string
}

/**
 * Read the registry from the environment rather than a constant.
 *
 * It is an ECR host in production, a local registry in a test, and getting it wrong is not a
 * failure anyone would notice quickly: the build succeeds and pushes somewhere nobody looks.
 */
export function buildSettingsFromEnv(): BuildSettings {
  const registry = process.env.BUILD_REGISTRY

  if (registry === undefined || registry === "") {
    throw new Error("BUILD_REGISTRY is not set; there is nowhere to push a built image")
  }

  /*
    No default for the credential, and no throw either.

    A local registry needs none and production cannot work without one, so neither "" nor a fixed
    name is right. The build's own failure is specific — a 403 fetching an anonymous token, naming
    the repository it could not push to — which is a better place to find out than a startup check
    that would have to guess whether this deployment's registry is one that authenticates.
  */
  const registryAuthSecret = process.env.BUILD_REGISTRY_AUTH_SECRET

  return {
    registry,
    insecureRegistry: process.env.BUILD_REGISTRY_INSECURE === "true",
    ...(registryAuthSecret === undefined || registryAuthSecret === ""
      ? {}
      : { registryAuthSecret }),
  }
}

/**
 * Build one deployment's image (phase 10).
 *
 * Creates a BuildKit Job, waits for it within a budget, records what happened against
 * `deployment_build`, and hands the deployment on to `deploy.revision`.
 *
 * **The build is not retried here.** `backoffLimit: 0` on the Job and no loop around it: a build
 * that failed fails the same way again, and each attempt is minutes of billed compute. Retrying is
 * the queue's decision, where `maxAttempts` says how many times.
 *
 * Like `deploy.revision`, the wait is bounded and then handed back. A first build of a large image
 * takes longer than any lease should be held.
 */
export function buildImage(config?: KubeConfig, settings?: BuildSettings): JobHandler {
  return async (job, { db, keepAlive, signal }) => {
    const { deploymentId } = job.payload as BuildPayload

    const found = await fetchDeployment(db).withProject(deploymentId)
    if (found === undefined) return

    const { deployment, project } = found
    if (deployment.status === "torn_down") return

    // Already built. A retried job must not pay for the same image twice, and the deployment is
    // waiting on the revision rather than on this.
    if (deployment.imageUri !== null) {
      await enqueue(db, {
        kind: DEPLOY_KINDS.revision,
        organizationId: project.organizationId,
        payload: { deploymentId },
        idempotencyKey: revisionKey(deploymentId, deployment.imageUri),
      })
      return
    }

    const source = await db
      .selectFrom("project")
      .innerJoin("repository", "repository.id", "project.repositoryId")
      .select([
        "repository.ownerLogin as ownerLogin",
        "repository.name as repoName",
        // The two build settings. `root_dir` has been on `project` since the first migration and
        // was read by nothing; the build assumed the repository root and a Dockerfile beside it.
        "project.rootDir as rootDir",
        "project.dockerfilePath as dockerfilePath",
      ])
      .where("project.id", "=", project.id)
      .executeTakeFirst()

    if (source === undefined) {
      await crudDeployment(db).update(deploymentId, { status: "error" })
      throw new Error(`Deployment ${deploymentId} has no repository to build from`)
    }

    // The registry belongs to the cluster this will run on, not to the process doing the building.
    //
    // Pulling an image across clouds works — a GKE node can pull from AWS ECR — and it costs
    // cross-cloud egress on every pull, and the ECR credential it needs expires after twelve hours,
    // so a static pull secret stops working overnight. An image is pushed to the registry of the
    // cloud that will run it.
    const placement = await fetchPlacement(db).forProject(project.id)

    const fallback = settings ?? buildSettingsFromEnv()
    const resolved =
      placement?.registry != null
        ? {
            registry: placement.registry,
            insecureRegistry: fallback.insecureRegistry,
            registryAuthSecret: fallback.registryAuthSecret,
          }
        : fallback
    const spec: BuildSpec = {
      deploymentId,
      gitSha: deployment.gitSha,
      repositoryUrl: `https://github.com/${source.ownerLogin}/${source.repoName}.git`,
      registry: resolved.registry,
      // Namespaced by organization so two customers cannot collide on a repository path, and so a
      // registry policy can be written per organization rather than per project.
      imageRepository: `${project.organizationId}/${project.slug}`,
      insecureRegistry: resolved.insecureRegistry,
      contextSubdir: source.rootDir,
      dockerfilePath: source.dockerfilePath,
      ...(resolved.registryAuthSecret === undefined
        ? {}
        : { registryAuthSecret: resolved.registryAuthSecret }),
    }

    const kube = createKubeClient(config ?? inClusterConfig())
    const name = buildJobName(deploymentId)
    const path = jobPath(BUILD_NAMESPACE, name)

    await crudDeployment(db).update(deploymentId, {
      status: "building",
      // Recorded at build time rather than at deploy time: the image lands in this cluster's
      // registry, so by the time it is built the placement is already a fact rather than a plan.
      ...(placement === undefined ? {} : { clusterId: placement.clusterId }),
    })

    const build = await crudDeploymentBuild(db).create({
      deploymentId,
      builder: "buildkit",
      startedAt: new Date(),
    })

    /*
      A finished Job is deleted before the next attempt, and this is what made a retry possible.

      The Job is named from the deployment so a handler that resumes mid-build addresses the same
      Job rather than paying for the build twice. That is right while it is *running*. Once it has
      finished, `spec.template` is immutable and the server refuses the apply outright:

          Job.batch "build-<id>" is invalid: spec.template: Invalid value: …

      So a build that failed could never be retried. The queue dutifully tried five times, every
      attempt was rejected by the API server before a pod existed, and the deployment
      dead-lettered under `Build failed` — a message about a build that had not been attempted.

      Only when it has finished. A Job still running is left alone, which keeps the property the
      name was chosen for.
    */
    const existing = await kube.get<JobStatus>(path)

    if (shouldRecreate(existing)) {
      await kube.remove(path)
      // The delete is propagated in the background, so the name is not free the instant it returns.
      // Applying into a terminating Job fails with `object is being deleted`, which reads as a
      // different problem entirely.
      await waitForAbsence(kube, path, signal)
    }

    await kube.apply(path, buildJob(spec, BUILD_NAMESPACE))

    const deadline = Date.now() + WATCH_BUDGET_MS

    while (Date.now() < deadline) {
      if (!(await keepAlive())) return

      const current = await kube.get<JobStatus>(path)

      if ((current?.status?.succeeded ?? 0) > 0) {
        await crudDeploymentBuild(db).update(build.id, { finishedAt: new Date(), exitCode: 0 })
        await crudDeployment(db).update(deploymentId, { imageUri: imageUri(spec) })

        await enqueue(db, {
          kind: DEPLOY_KINDS.revision,
          organizationId: project.organizationId,
          payload: { deploymentId },
          idempotencyKey: revisionKey(deploymentId, imageUri(spec)),
        })
        return
      }

      if ((current?.status?.failed ?? 0) > 0) {
        const reason = await buildFailureReason(kube, deploymentId)
        await crudDeploymentBuild(db).update(build.id, {
          finishedAt: new Date(),
          exitCode: 1,
          failureReason: reason,
        })
        await crudDeployment(db).update(deploymentId, { status: "error" })
        throw new Error(`Build failed for deployment ${deploymentId}: ${reason}`)
      }

      await sleep(POLL_INTERVAL_MS, signal)
    }

    await enqueue(db, {
      kind: BUILD_KINDS.image,
      organizationId: project.organizationId,
      payload: { deploymentId },
      runAt: new Date(Date.now() + POLL_INTERVAL_MS * 4),
      idempotencyKey: `${BUILD_KINDS.image}:${deploymentId}:${job.attempt}:recheck`,
    })
  }
}

/** How much of a build log to keep. Enough for the error and the lines around it. */
const FAILURE_REASON_LIMIT = 4000

type PodList = {
  items?: {
    status?: {
      phase?: string
      conditions?: { type?: string; status?: string; reason?: string; message?: string }[]
      containerStatuses?: {
        state?: {
          terminated?: { reason?: string; message?: string; exitCode?: number }
          waiting?: { reason?: string; message?: string }
        }
      }[]
    }
    metadata?: { name?: string }
  }[]
}

/**
 * Why the build failed, in the words of whatever refused it.
 *
 * The handler used to throw `Build failed for deployment <uuid>` and that string was the whole
 * record. Every real failure needed a `kubectl logs` to explain, and the explanation was sitting
 * right there at the moment the platform discarded it: a missing Dockerfile, a registry that
 * refused the push, a pod that could not be scheduled.
 *
 * The pod's *status* is consulted before its logs, and that ordering is the point. A build that was
 * never scheduled has no logs at all — `0/3 nodes are available: 2 Insufficient cpu` lives in a
 * scheduling condition — and reading logs first would report an empty string for the one failure
 * mode whose cause is least guessable from the outside.
 *
 * Never throws. This runs on the failure path, and a build whose *explanation* fails to load must
 * still report the failure it was explaining.
 */
export async function buildFailureReason(
  kube: Pick<ReturnType<typeof createKubeClient>, "get" | "logs">,
  deploymentId: string,
): Promise<string> {
  try {
    const selector = encodeURIComponent(`sproutos.dev/deployment=${deploymentId}`)
    const pods = await kube.get<PodList>(
      `/api/v1/namespaces/${BUILD_NAMESPACE}/pods?labelSelector=${selector}`,
    )

    const pod = pods?.items?.[0]
    if (pod === undefined) return "the build pod is gone; nothing recorded why it failed"

    const container = pod.status?.containerStatuses?.[0]?.state

    if (container?.waiting?.reason !== undefined) {
      return trim(`${container.waiting.reason}: ${container.waiting.message ?? ""}`)
    }

    // Pending with an `Unschedulable` condition: the pod never ran, so there is nothing to tail.
    if (pod.status?.phase === "Pending") {
      const blocked = pod.status.conditions?.find((condition) => condition.status === "False")
      return trim(
        blocked === undefined
          ? "the build pod never started, and the cluster gave no reason"
          : `${blocked.reason ?? "Pending"}: ${blocked.message ?? ""}`,
      )
    }

    const name = pod.metadata?.name
    const log =
      name === undefined
        ? ""
        : await kube.logs(
            `/api/v1/namespaces/${BUILD_NAMESPACE}/pods/${name}/log?container=buildkit`,
          )

    const tail = log.trim()
    if (tail !== "") return trim(tail.slice(-FAILURE_REASON_LIMIT))

    const terminated = container?.terminated
    return trim(
      terminated === undefined
        ? "the build container produced no output and no status"
        : `exit ${terminated.exitCode ?? "?"} ${terminated.reason ?? ""} ${terminated.message ?? ""}`,
    )
  } catch (cause) {
    // The explanation failed to load. Say that, rather than letting it replace the failure it was
    // explaining — which is how a constraint violation inside a catch has hidden a real error here
    // before (see docs/findings/0010).
    return `could not read why the build failed: ${String(cause)}`
  }
}

function trim(value: string): string {
  return value.trim().slice(0, FAILURE_REASON_LIMIT)
}

/**
 * The idempotency key for "deploy this image".
 *
 * Keyed on the deployment **and the image**, not the deployment alone.
 *
 * On the deployment alone, the key is taken forever by the first attempt. A deployment whose first
 * build failed has already had a `deploy.revision` job — enqueued and completed against no image —
 * so when a later build succeeds and pushes, the enqueue collides and does nothing. The image is
 * built, pushed, and never deployed, with every job in the chain reporting success. Observed
 * exactly that way: `deploy.build succeeded`, `image_uri` set, no revision, no URL.
 *
 * The image is the right discriminator because it is what actually changes. Retrying the same build
 * produces the same tag — the image is named for the commit — so a retry still collides, which is
 * the property the key was added for.
 */
export function revisionKey(deploymentId: string, image: string): string {
  return `${DEPLOY_KINDS.revision}:${deploymentId}:${image}`
}

/**
 * Whether the Job at this name has to be replaced rather than updated.
 *
 * A finished Job must be: `spec.template` is immutable, so applying a new one is refused by the API
 * server before a pod exists. A running Job must not be — leaving it alone is the whole reason the
 * Job is named from the deployment.
 *
 * Absent is neither: there is nothing to delete, and the apply creates it.
 */
export function shouldRecreate(existing: JobStatus | undefined): boolean {
  if (existing === undefined) return false
  return (existing.status?.succeeded ?? 0) > 0 || (existing.status?.failed ?? 0) > 0
}

/** How long to wait for a deleted Job's name to become free. */
const DELETION_TIMEOUT_MS = 30_000

/**
 * Wait until the object at `path` is gone.
 *
 * `DELETE` with background propagation returns as soon as the deletion is *accepted*, and the name
 * stays taken while the pods are cleaned up. Applying into that window fails with
 * `object is being deleted: … already exists`, which names the object rather than the race and
 * sends the reader looking for a second writer.
 *
 * Gives up rather than looping forever: a Job that will not go away is a cluster problem, and the
 * apply that follows will say so in the cluster's own words.
 */
export async function waitForAbsence(
  kube: Pick<ReturnType<typeof createKubeClient>, "get">,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + DELETION_TIMEOUT_MS

  // `signal.aborted` as well as the deadline: `sleep` *resolves* on abort rather than throwing, so
  // a loop that only checked the clock would spin as fast as the API server could answer for the
  // rest of its budget — during a shutdown, which is exactly when it should stop.
  while (Date.now() < deadline && signal?.aborted !== true) {
    const current = await kube.get<JobStatus>(path)
    if (current === undefined) return
    await sleep(500, signal)
  }
}
