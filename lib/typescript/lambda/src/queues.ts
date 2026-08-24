import type { Redis } from "ioredis"

/**
 * The tenant queues the router watches, and how to reach each one.
 *
 * The router dispatches customer workflows (§4.6): it watches BullMQ and Celery keyspaces on the
 * tenant Valkey and invokes a Lambda worker per batch. To watch a queue it needs the broker URI,
 * and this is where the control plane leaves it — the same platform Valkey the route map lives in,
 * for the same reason: the router reads it on a hot path and must not need a database.
 *
 * **This replaces a Kubernetes Secret.** The broker URI used to be written into the tenant's
 * namespace so a worker Deployment could mount it. There is no namespace and no Deployment; the
 * consumer is one Rust process, and a key it can read is the whole requirement.
 *
 * Same format rule as the route map: one string key holding JSON, because Rust parses it.
 */

const PREFIX = "queue:"

export type QueueBinding = {
  /** How the router connects to the tenant Valkey this queue lives on. */
  uri: string
  backendServiceId: string
  projectId: string | null
  organizationId: string
}

function key(backendServiceId: string): string {
  return `${PREFIX}${backendServiceId}`
}

/**
 * Publish a queue for the router to watch.
 *
 * No TTL, unlike a route. A route expires so a project deleted during a partition stops resolving;
 * a queue binding that expired would silently stop a customer's workflows from running, with no
 * error anywhere — the failure mode of forgetting is much worse here than the failure mode of
 * remembering, and teardown withdraws it explicitly.
 */
export async function publishQueue(valkey: Redis, binding: QueueBinding): Promise<void> {
  await valkey.set(key(binding.backendServiceId), JSON.stringify(binding))
}

export async function readQueue(
  valkey: Redis,
  backendServiceId: string,
): Promise<QueueBinding | undefined> {
  const raw = await valkey.get(key(backendServiceId))
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as QueueBinding
  } catch {
    return undefined
  }
}

/** Stop the router watching a queue. Called when the service is destroyed. */
export async function withdrawQueue(valkey: Redis, backendServiceId: string): Promise<void> {
  await valkey.del(key(backendServiceId))
}
