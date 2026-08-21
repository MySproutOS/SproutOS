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

  return { registry, insecureRegistry: process.env.BUILD_REGISTRY_INSECURE === "true" }
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
        idempotencyKey: `${DEPLOY_KINDS.revision}:${deploymentId}`,
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
        ? { registry: placement.registry, insecureRegistry: fallback.insecureRegistry }
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
          idempotencyKey: `${DEPLOY_KINDS.revision}:${deploymentId}`,
        })
        return
      }

      if ((current?.status?.failed ?? 0) > 0) {
        await crudDeploymentBuild(db).update(build.id, { finishedAt: new Date(), exitCode: 1 })
        await crudDeployment(db).update(deploymentId, { status: "error" })
        throw new Error(`Build failed for deployment ${deploymentId}`)
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
