import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { crudDeployment, fetchDeployment, fetchProjectEnvVar, fetchProjectFile } from "@lib/dao"
import {
  type ConfigFile,
  configSecret,
  type EnvironmentEntry,
  type FileMount,
  fileMounts,
  isDeliverableKey,
  isMountablePath,
  secretPath,
  createKubeClient,
  inClusterConfig,
  type KnativeService,
  knativeService,
  knativeServicePath,
  type KubeConfig,
} from "@lib/deploy"
import { openEnvVarValue, openProjectFileContents } from "@lib/envelope"
import { ensureTenantNamespace } from "@lib/sandbox"
import { BUILD_KINDS } from "./build"
import { enqueue } from "./queue"
import { sleep } from "./sleep"
import type { JobHandler } from "./worker"

export const DEPLOY_KINDS = {
  revision: "deploy.revision",
} as const

type DeployPayload = { deploymentId: string }

/**
 * Decrypt a project's variables for one deployment target and put them in the cluster.
 *
 * Returns the Secret's name, or `null` when there is nothing to deliver — which the renderer turns
 * into no `envFrom` at all rather than a reference to an empty object.
 *
 * **`target` is `all` plus the deployment's own kind.** That is what the column is for: a preview
 * gets the preview variables and the shared ones, and production's secrets stay out of a pull
 * request's build — which matters, because a preview deployment runs code from a branch anybody
 * with a fork can open.
 *
 * The Secret is never deleted here. Its name is a hash of its contents, so every environment a
 * project has ever deployed with keeps its own object, and a rollback to an earlier revision finds
 * the environment that revision actually ran with. `project.teardown` collects them by label.
 */
export async function materializeEnvironment(
  db: Kysely<DB>,
  kube: ReturnType<typeof createKubeClient>,
  projectId: string,
  namespace: string,
  target: string,
): Promise<{ secretName: string | null; mounts: FileMount[] }> {
  const sealed = await fetchProjectEnvVar(db).listSealedForProject(projectId, target)
  const sealedFiles = await fetchProjectFile(db).listSealedForProject(projectId, target)
  if (sealed.length === 0 && sealedFiles.length === 0) return { secretName: null, mounts: [] }

  const entries: EnvironmentEntry[] = []
  const undeliverable: string[] = []

  for (const row of sealed) {
    /*
      Refused rather than renamed.

      A Secret key must match `[-._a-zA-Z0-9]+` and the API server rejects the whole object
      otherwise — so one variable named with a space would make every *other* variable undeliverable,
      as a 422 several steps from the cause. Sanitising instead would deliver a variable under a name
      the customer's code does not read, which looks exactly like the platform ignoring it.
    */
    if (!isDeliverableKey(row.key)) {
      undeliverable.push(row.key)
      continue
    }

    entries.push({
      key: row.key,
      value: await openEnvVarValue(projectId, row.key, {
        ciphertext: row.valueCiphertext,
        kmsKeyId: row.valueKmsKeyId,
        wrappedDek: row.valueWrappedDek,
      }),
    })
  }

  const files: ConfigFile[] = []

  for (const row of sealedFiles) {
    // Refused rather than corrected, for the reason a bad variable name is: a file mounted at a
    // path the customer did not ask for is a file their application does not read, which looks the
    // same as the platform ignoring it. The column has the same constraint, so this should be
    // unreachable — it is here because "should be unreachable" is not a guarantee.
    if (!isMountablePath(row.path)) {
      undeliverable.push(row.path)
      continue
    }

    files.push({
      path: row.path,
      contents: await openProjectFileContents(projectId, row.path, {
        ciphertext: row.contentsCiphertext,
        kmsKeyId: row.contentsKmsKeyId,
        wrappedDek: row.contentsWrappedDek,
      }),
    })
  }

  if (undeliverable.length > 0) {
    // Not thrown. A deployment that fails outright because one variable or file has an unusable
    // name is a worse outcome than one that runs without it and says so.
    console.warn(
      `project ${projectId}: ${undeliverable.length} item(s) could not be delivered — a variable ` +
        `name Kubernetes cannot carry, or a path that cannot be mounted: ${undeliverable.join(", ")}`,
    )
  }

  if (entries.length === 0 && files.length === 0) return { secretName: null, mounts: [] }

  const secret = configSecret(projectId, namespace, entries, files)
  await kube.apply(secretPath(namespace, secret.metadata.name), secret)
  return { secretName: secret.metadata.name, mounts: fileMounts(files) }
}

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

    const kube = createKubeClient(config ?? inClusterConfig())

    // The namespace and its NetworkPolicies first — a deployed revision is customer code too, and
    // it reaches the network far more than a workflow node does.
    await ensureTenantNamespace(kube, namespace)

    /*
      The environment, which for a long time went nowhere.

      Applied before the Service, because the Service references it by name and a `secretRef` to an
      object that does not exist fails the pod with `CreateContainerConfigError` — a message that
      reads like a broken image.
    */
    const configuration = await materializeEnvironment(
      db,
      kube,
      project.id,
      namespace,
      deployment.kind,
    )

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
        envSecretName: configuration.secretName,
        configFiles: configuration.mounts,
      },
      namespace,
    )

    const path = knativeServicePath(namespace, service.metadata.name)

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
