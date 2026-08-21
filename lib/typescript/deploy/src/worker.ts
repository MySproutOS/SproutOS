import { attributionLabels } from "@lib/metering"

/**
 * The queue worker a tenant's jobs are consumed by — TASK 20's "spins up services as needed".
 *
 * ## Why a Deployment and not a Knative Service
 *
 * Everything else a tenant runs is a Knative Service, and Knative's scale-to-zero is exactly the
 * cost model this platform is built on. It does not fit here: Knative scales on **HTTP requests
 * arriving at the revision**, and a BullMQ worker is not called, it calls. A queue with ten thousand
 * jobs generates no HTTP traffic at all, so a Knative worker would sit at zero replicas forever
 * while the queue grew.
 *
 * The scale signal has to come from the queue, which is what the master queue in
 * `services/valkey-proxy` reports and what `dispatchQueues` acts on. A plain Deployment whose
 * `replicas` that dispatcher sets is the honest primitive: the thing that knows is the thing that
 * decides.
 *
 * ## One worker per queue
 *
 * Not one per project. A project with a `emails` queue and a `video` queue has two workloads with
 * completely different duty cycles — the point of scaling from zero is that the idle one costs
 * nothing, and a single worker process consuming both would keep a pod alive for whichever is busy.
 *
 * ## What the worker is
 *
 * The project's own deployed image, with the queue named in the environment. SproutOS generates the
 * worker code for a workflow (see `tenantQueuePrefix` in `@lib/queue`), so the image already
 * contains a consumer; what it does not know until now is which queue to consume and how to reach
 * the broker.
 */

/** The connection details a worker needs to reach its queue through the proxy. */
export type WorkerSpec = {
  namespace: string
  /** The tenant's deployed image. */
  image: string
  /** The queue name as the tenant's code knows it, without any namespace. */
  queue: string
  /**
   * The Secret holding the broker URI. See {@link queueSecretName}.
   *
   * A name, not the URI. Putting a connection string carrying a secret into a Deployment's `env`
   * makes it readable by anyone with `get deployments` and puts it in every `kubectl describe`;
   * a Secret keeps it to `get secrets` in one namespace, which is a grant the platform does not
   * hand out.
   */
  secretName: string
  organizationId: string
  projectId: string
  /** `kata-fc` or `kata-clh` where a runtime class exists; absent otherwise. */
  runtimeClassName?: string
  cpu?: string
  memory?: string
}

export type WorkerDeployment = {
  apiVersion: "apps/v1"
  kind: "Deployment"
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: Record<string, unknown>
}

/**
 * A DNS label for one (project, queue) worker.
 *
 * The queue name is a customer string: it can be long, contain characters a label may not, and
 * differ from another queue only past the 63-character limit. So the label is a fixed prefix, a
 * sanitized hint for whoever reads `kubectl get deploy`, and the project's own short suffix — and
 * the *queue* is carried in a label rather than in the name, where it can hold anything.
 */
export function workerName(projectId: string, queue: string): string {
  const hint = queue
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 20)
  const suffix = projectId.replaceAll("-", "").slice(-12)
  return hint === "" ? `wk-${suffix}` : `wk-${hint}-${suffix}`
}

/** The label carrying the queue name, which a name cannot. */
export const QUEUE_LABEL = "sproutos.dev/queue"

export function workerDeployment(spec: WorkerSpec, replicas: number): WorkerDeployment {
  const name = workerName(spec.projectId, spec.queue)

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: spec.namespace,
      labels: {
        "app.kubernetes.io/part-of": "sproutos",
        "sproutos.dev/worker": "queue",
        ...attributionLabels(spec.organizationId, spec.projectId),
      },
    },
    spec: {
      // Set by `dispatchQueues`, from the master queue. This is the whole scale-from-zero path.
      replicas,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": name,
            "sproutos.dev/worker": "queue",
            /*
              The queue, as a label rather than in the name.

              A label value may be up to 63 characters and a queue name may be longer, so this is
              truncated — it exists so an operator can see which queue a pod serves, and the
              authoritative copy is the environment variable below. Truncating a *name* would make
              two queues collide; truncating a label makes one display string ambiguous.
            */
            [QUEUE_LABEL]: spec.queue.slice(0, 63),
            // What makes the worker's compute billable. Every pod SproutOS creates for a customer
            // carries these; see `attributionLabels`.
            ...attributionLabels(spec.organizationId, spec.projectId),
          },
        },
        spec: {
          ...(spec.runtimeClassName === undefined
            ? {}
            : { runtimeClassName: spec.runtimeClassName }),
          /*
            No service-account token.

            A queue worker runs the customer's code, so it gets the same treatment as a sandbox: no
            credential for the API server, no root, no capabilities. The tenant NetworkPolicy is the
            other half and is applied by `ensureTenantNamespace` before anything lands here.
          */
          automountServiceAccountToken: false,
          containers: [
            {
              name: "worker",
              image: spec.image,
              env: [
                // The queue name is not a secret and is per-worker, so it does not belong in the
                // shared Secret below.
                { name: "SPROUT_QUEUE_NAME", value: spec.queue },
              ],
              /*
                The broker URI, from a Secret in the tenant's own namespace.

                `REDIS_URL` as well as `SPROUT_QUEUE_URL`, because BullMQ and Celery both look for
                the conventional name and a worker the customer wrote should not need to know ours.
              */
              envFrom: [{ secretRef: { name: spec.secretName } }],
              resources: {
                requests: { cpu: spec.cpu ?? "100m", memory: spec.memory ?? "256Mi" },
                // CPU is deliberately unlimited while memory is not. A worker that is throttled
                // takes longer and costs the same; a worker that leaks takes the node down.
                limits: { memory: spec.memory ?? "256Mi" },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65534,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                seccompProfile: { type: "RuntimeDefault" },
              },
            },
          ],
        },
      },
    },
  }
}

/** Where a Deployment lives in the API. */
export function workerPath(namespace: string, name: string): string {
  return `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`
}

/**
 * The Secret in a tenant namespace holding one queue's broker URI.
 *
 * ## Why this exists at all
 *
 * A worker started by the platform has to authenticate to the tenant's queue, and the platform
 * cannot recover the tenant's secret: `service_credential` stores a hash, which is the property
 * that makes a stolen credential table worthless and is worth keeping. `connectionUri` on the
 * Valkey driver throws for exactly this reason.
 *
 * A second credential is not available either — `valkey-proxy` looks a credential up by username,
 * and a username is derived from the resource, so two rows for one service would differ only by
 * secret and the lookup takes the first.
 *
 * So the URI is captured at the one moment it exists: when the service is provisioned and the
 * plaintext is on its way to the customer for the only time. It goes into a Secret in the tenant's
 * namespace, which is where a worker pod needs it and nowhere else.
 *
 * ## A service provisioned before this existed has no Secret
 *
 * There is no way to make one. The consequence is stated rather than worked around: `dispatchQueues`
 * reports the queue as unstartable, and the customer gets a worker by rotating the credential —
 * which is a visible action with a visible effect (the old URI stops working) rather than something
 * the platform does to a running application behind their back.
 */
export function queueSecretName(resourceShortId: string): string {
  return `queue-${resourceShortId}`
}

export function queueSecret(
  namespace: string,
  resourceShortId: string,
  connectionUri: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: queueSecretName(resourceShortId),
      namespace,
      labels: { "app.kubernetes.io/part-of": "sproutos", "sproutos.dev/queue-secret": "true" },
    },
    type: "Opaque",
    // `stringData`, not `data`: the API server base64-encodes it, and doing that here would mean a
    // second place to get an encoding wrong for no benefit.
    stringData: {
      SPROUT_QUEUE_URL: connectionUri,
      REDIS_URL: connectionUri,
    },
  }
}

/**
 * Where a Secret lives in the API.
 *
 * An empty name gives the *collection* path, which is what a label-selector delete needs — and is
 * the shape the API already uses, rather than a second function that would drift from this one.
 */
export function secretPath(namespace: string, name: string): string {
  const collection = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`
  return name === "" ? collection : `${collection}/${encodeURIComponent(name)}`
}
