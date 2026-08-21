import {
  createKubeClient,
  inClusterConfig,
  type KubeConfig,
  queueSecret,
  queueSecretName,
  secretPath,
  workerDeployment,
  workerName,
  workerPath,
} from "@lib/deploy"
import { ensureTenantNamespace, sandboxRuntimeClass } from "@lib/sandbox"
import { decodeShortId, valkeyDriver, valkeyServiceConfigFromEnv } from "@lib/services"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { tenantNamespace } from "./deploy"

/**
 * The master-queue consumer — the half of TASK 20 that turns a report into a running worker.
 *
 * > We use a proxy that receives valkey commands and adds it to a master valkey queue such that
 * > this proxy consumer continuously receives jobs from all projects and spins up services as
 * > needed.
 *
 * `services/valkey-proxy` writes into one sorted set on the tenant instance:
 *
 * ```text
 * ZADD sproutos:master:wake GT <epoch_ms> "<resource-short-id>/<queue>"
 * ```
 *
 * Member is the queue, score is the last time work arrived. This reads it and decides one thing per
 * entry: should there be a worker pod, or not.
 *
 * ## Why the proxy has to be the one reporting
 *
 * The alternative is polling: ask every tenant's queue whether it has work. On a shared instance
 * that means scanning a keyspace holding every tenant's keys, which is the one operation the proxy
 * refuses on principle — and it would cost a round trip per queue per interval whether or not
 * anything is happening. The proxy already sees every enqueue; it is the only component that can
 * answer for free.
 *
 * ## Scaling down is the harder half
 *
 * Starting a worker is a decision made from evidence: work arrived. Stopping one is made from the
 * *absence* of evidence, and absence is indistinguishable from a proxy that has been unable to
 * report. So the down decision is deliberately slower than the up decision — see `IDLE_MS` — and it
 * is made from the score, which every proxy replica keeps current with `GT`.
 */

/** The sorted set every `valkey-proxy` replica reports into. Mirrors `MASTER_WAKE_KEY` in Rust. */
export const MASTER_WAKE_KEY = "sproutos:master:wake"

/**
 * How long after the last enqueue a worker is scaled back to zero.
 *
 * Generous on purpose. A worker that stops one second after the queue empties will be started again
 * by the next job, and a cold start costs an image pull; the saving from being aggressive here is
 * seconds of a pod, and the cost is latency on every job that follows a lull. Ten minutes also
 * comfortably outlasts a proxy restart, so a brief inability to report does not read as an idle
 * queue.
 */
export const IDLE_MS = 10 * 60 * 1000

/**
 * How long an entry stays in the set after its worker has been stopped.
 *
 * Removed rather than left at zero replicas, so the set does not grow without bound as queues come
 * and go — a tenant who deletes a project would otherwise leave an entry that is consulted forever.
 * The removal happens only after the scale-down succeeds, so a failure means it is reconsidered next
 * run rather than forgotten with a worker still running.
 */
export type DispatchResult = {
  /** Queues seen in the master set. */
  seen: number
  /** Workers scaled up because work arrived. */
  started: number
  /** Workers scaled to zero because the queue went quiet. */
  stopped: number
  /** Queues that could not get a worker, by reason. See {@link Unstartable}. */
  unstartable: Record<Unstartable, number>
  /** Members this encoding never produced, removed on sight. */
  undecodable: number
}

/**
 * The two Valkey commands this needs, named structurally.
 *
 * Not `Pick<Redis, "zrange" | "zrem">`: `zrange` is heavily overloaded and picking it drags in
 * every signature, so the `WITHSCORES` call does not resolve. Naming the two shapes used here also
 * means a test hands in an object literal rather than mocking a client.
 */
export type MasterQueueClient = {
  zrange(key: string, start: number, stop: number, withScores: "WITHSCORES"): Promise<string[]>
  zrem(key: string, member: string): Promise<number>
}

/** One entry of the master set. */
export type Wake = { resource: string; queue: string; lastSeen: number }

/**
 * Every wake in a `ZRANGE … WITHSCORES` reply, in either shape the protocol produces.
 *
 * **RESP2 gives a flat array** — `[member, score, member, score]` — and **RESP3 gives pairs**:
 * `[[member, score], [member, score]]`. Which arrives depends on the protocol the client
 * negotiated, and `ioredis` 6 negotiates RESP3 by default.
 *
 * Reading only the flat shape is not an error. It is worse: every element is an array, nothing
 * parses, and the dispatcher reports zero queues against a set that is full — which reads exactly
 * like a quiet platform. That is how this was found, with the entry sitting in the set, the job
 * succeeding, and no worker anywhere.
 *
 * Both shapes are handled rather than the protocol being pinned, because pinning it stays correct
 * only until somebody upgrades a client for an unrelated reason.
 */
export function parseWakes(reply: unknown[]): Wake[] {
  const wakes: Wake[] = []

  // RESP3: an array of [member, score] pairs.
  if (Array.isArray(reply[0])) {
    for (const entry of reply) {
      if (!Array.isArray(entry)) continue
      const parsed = parseMember(String(entry[0]), Number(entry[1]))
      if (parsed !== undefined) wakes.push(parsed)
    }
    return wakes
  }

  // RESP2: member, score, member, score.
  for (let index = 0; index + 1 < reply.length; index += 2) {
    const parsed = parseMember(String(reply[index]), Number(reply[index + 1]))
    if (parsed !== undefined) wakes.push(parsed)
  }
  return wakes
}

/**
 * Parse `<resource-short-id>/<queue>` back into its parts.
 *
 * Split on the **first** slash: a queue name may contain one and a Crockford short id may not, which
 * is what makes the encoding unambiguous in the direction that matters.
 */
export function parseMember(member: string, score: number): Wake | undefined {
  const slash = member.indexOf("/")
  if (slash <= 0 || slash === member.length - 1) return undefined
  return {
    resource: member.slice(0, slash),
    queue: member.slice(slash + 1),
    lastSeen: score,
  }
}

/**
 * Read the master set, start what has work, stop what does not.
 *
 * The Valkey client is a parameter so a test can hand in a fake and so the caller owns the
 * connection's lifetime — this runs on a schedule and opening a connection per run would be a
 * connection per ten minutes for the life of the process.
 */
export async function dispatchQueues(
  db: Kysely<DB>,
  redis: MasterQueueClient,
  options: { now?: number; config?: KubeConfig } = {},
): Promise<DispatchResult> {
  const now = options.now ?? Date.now()
  const kube = createKubeClient(options.config ?? inClusterConfig())

  const wakes = parseWakes(await redis.zrange(MASTER_WAKE_KEY, 0, -1, "WITHSCORES"))

  const result: DispatchResult = {
    seen: wakes.length,
    started: 0,
    stopped: 0,
    unstartable: { "no-service": 0, "no-project": 0, "no-image": 0, "no-secret": 0 },
    undecodable: 0,
  }

  for (const wake of wakes) {
    let serviceId: string
    try {
      serviceId = decodeShortId(wake.resource)
    } catch {
      /*
        A member this encoding never produced.

        Removed rather than retried: nothing will ever decode it, so leaving it in means examining
        it on every run forever. The only way one gets here is a client writing to the master key
        directly, which the proxy's own allowlist prevents for tenants.
      */
      await redis.zrem(MASTER_WAKE_KEY, `${wake.resource}/${wake.queue}`)
      result.undecodable += 1
      continue
    }

    const target = await workerTarget(db, serviceId, wake.resource)
    if (typeof target === "string") {
      /*
        Left in the set, not removed.

        Every one of these can stop being true: a project deploys for the first time, a customer
        rotates a credential and gets a Secret. Removing the entry would mean the queue is only
        reconsidered when something is enqueued into it again, which for a queue that already has a
        backlog may be never.
      */
      result.unstartable[target] += 1
      continue
    }

    const idle = now - wake.lastSeen > IDLE_MS
    const namespace = tenantNamespace(target.organizationId)
    const name = workerName(target.projectId, wake.queue)

    if (idle) {
      const current = await kube.get<{ spec?: { replicas?: number } }>(workerPath(namespace, name))
      // Nothing to stop. Remove the entry so a queue that went quiet before a worker ever started
      // does not keep being reconsidered.
      if (current === undefined) {
        await redis.zrem(MASTER_WAKE_KEY, `${wake.resource}/${wake.queue}`)
        continue
      }

      await kube.apply(
        workerPath(namespace, name),
        workerDeployment(
          {
            namespace,
            image: target.imageUri,
            queue: wake.queue,
            secretName: target.secretName,
            organizationId: target.organizationId,
            projectId: target.projectId,
            ...(sandboxRuntimeClass() === undefined
              ? {}
              : { runtimeClassName: sandboxRuntimeClass() }),
          },
          0,
        ),
      )
      // After the scale-down, not before: a failure above must leave the entry so the next run
      // tries again rather than forgetting a worker that is still running.
      await redis.zrem(MASTER_WAKE_KEY, `${wake.resource}/${wake.queue}`)
      result.stopped += 1
      continue
    }

    // The namespace and its NetworkPolicies before the pod, every time — the worker runs a
    // customer's code and the namespace existing is not evidence that it is fenced.
    await ensureTenantNamespace(kube, namespace)

    await kube.apply(
      workerPath(namespace, name),
      workerDeployment(
        {
          namespace,
          image: target.imageUri,
          queue: wake.queue,
          secretName: target.secretName,
          organizationId: target.organizationId,
          projectId: target.projectId,
          ...(sandboxRuntimeClass() === undefined
            ? {}
            : { runtimeClassName: sandboxRuntimeClass() }),
        },
        1,
      ),
    )
    result.started += 1
  }

  return result
}

/**
 * Give a queue a worker credential and put it where the worker will read it.
 *
 * Returns whether it worked. A failure is not fatal to the run: one queue that could not be set up
 * must not cost every other tenant their worker, and the reason is logged with enough to act on.
 *
 * The order is deliberate — the Secret is written before the row records it. A row claiming a Secret
 * that does not exist would make every later run skip straight to starting a worker that cannot
 * start; the other way round costs one wasted credential and self-corrects on the next run.
 */
async function issueWorkerSecret(
  db: Kysely<DB>,
  serviceId: string,
  organizationId: string,
  shortId: string,
): Promise<boolean> {
  try {
    const uri = await valkeyDriver(db, valkeyServiceConfigFromEnv()).issueWorkerCredential(
      serviceId,
    )

    const namespace = tenantNamespace(organizationId)
    const kube = createKubeClient(inClusterConfig())
    // The namespace and its policies before the Secret: this is a credential, and it is about to
    // live somewhere a tenant's pods can reach.
    await ensureTenantNamespace(kube, namespace)
    await kube.apply(
      secretPath(namespace, queueSecretName(shortId)),
      queueSecret(namespace, shortId, uri),
    )

    await db
      .updateTable("backendService")
      .set({ workerSecretAt: new Date(), updatedAt: new Date() })
      .where("id", "=", serviceId)
      .execute()

    return true
  } catch (cause) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "could not issue a worker credential for this queue",
        backendServiceId: serviceId,
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    )
    return false
  }
}

/** What a worker needs, resolved from the backend service the wake named. */
type WorkerTarget = {
  organizationId: string
  projectId: string
  imageUri: string
  /** The Secret in the tenant namespace holding the broker URI. */
  secretName: string
}

/**
 * Why a wake might not become a worker.
 *
 * Named rather than logged as free text, because these are four different situations and only one
 * of them is anything to do about. `no-secret` is the one a customer can act on — see
 * `queueSecret`.
 */
export type Unstartable = "no-service" | "no-project" | "no-image" | "no-secret"

async function workerTarget(
  db: Kysely<DB>,
  serviceId: string,
  shortId: string,
): Promise<WorkerTarget | Unstartable> {
  const service = await db
    .selectFrom("backendService")
    .select(["organizationId", "projectId", "kind", "workerSecretAt"])
    .where("id", "=", serviceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()

  if (service === undefined || service.kind !== "valkey") return "no-service"

  /*
    A standalone queue belongs to an organization and to no project.

    TASK 37 says that shape is supported, and it is — as a *broker*. There is nothing here to start:
    the worker is the customer's own code, which lives in a project's image. A standalone queue's
    consumer runs wherever its owner runs it.
  */
  if (service.projectId === null) return "no-project"

  /*
    The image the project is actually serving.

    A worker running a different build than the site is a class of bug nobody enjoys, and the ready
    production deployment is the definition of "current". A project that has never deployed has
    nothing to run, which is not an error — it is a queue that will get a worker after its first
    deploy.
  */
  const deployment = await db
    .selectFrom("deployment")
    .select(["imageUri"])
    .where("projectId", "=", service.projectId)
    .where("kind", "=", "production")
    .where("status", "=", "ready")
    .where("imageUri", "is not", null)
    .orderBy("createdAt", "desc")
    .executeTakeFirst()

  const imageUri = deployment?.imageUri
  if (imageUri == null) return "no-image"

  /*
    The broker Secret the worker reads its URI from.

    Read from the row rather than from Kubernetes, and that is a security decision rather than a
    convenience: asking whether a Secret exists needs `get` on secrets, and granting the control
    plane that would let a compromised API pod read every credential in every tenant namespace. The
    grant is write-only, so the platform records what it wrote — see the
    `backend_service_worker_secret` migration.

    Missing is not a dead end. The platform issues the worker its **own** credential — a `worker`
    credential, distinct from the customer's, revocable without touching their application — writes
    it into the Secret, and records that. Nothing the customer has to do, and nothing of theirs that
    changes.

    An earlier version could not do this: one live credential per username was the constraint, so a
    worker's only possible URI was the customer's own, captured in passing during provisioning. Any
    queue older than that feature was stuck until its owner rotated. See the
    `service_credential_purpose` migration.
  */
  if (service.workerSecretAt === null) {
    const issued = await issueWorkerSecret(db, serviceId, service.organizationId, shortId)
    if (!issued) return "no-secret"
  }

  return {
    organizationId: service.organizationId,
    projectId: service.projectId,
    imageUri,
    secretName: queueSecretName(shortId),
  }
}
