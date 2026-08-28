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
  /**
   * The function a worker invocation goes to, when the service belongs to a project.
   *
   * Here rather than looked up from the route map, because the dispatcher has a queue and not a
   * hostname — and a project can have several hostnames but one function.
   */
  functionArn?: string
}

/**
 * Keyed by the resource's **short id**, not its UUID.
 *
 * That is what `valkey-proxy` reports into the master queue, because it is what the tenant's key
 * prefix carries — the proxy sees `sproutos:v-01m0j8…:bull:emails:wait` and never sees a UUID.
 * Keying this by UUID would mean the dispatcher had to reverse the encoding on every wake, or ask
 * the database, for a mapping that never changes.
 */
function key(resourceShortId: string): string {
  return `${PREFIX}${resourceShortId}`
}

function deletedKey(resourceShortId: string): string {
  return `${PREFIX}deleted:${resourceShortId}`
}

function targetKey(resourceShortId: string): string {
  return `${PREFIX}target:${resourceShortId}`
}

/**
 * Publish a queue for the router to watch.
 *
 * No TTL, unlike a route. A route expires so a project deleted during a partition stops resolving;
 * a queue binding that expired would silently stop a customer's workflows from running, with no
 * error anywhere — the failure mode of forgetting is much worse here than the failure mode of
 * remembering, and teardown withdraws it explicitly.
 */
const REPLACE_UNLESS_DELETED = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] == '' then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], ARGV[2])
end
return 1
`

export async function publishQueue(
  valkey: Redis,
  resourceShortId: string,
  binding: QueueBinding,
): Promise<boolean> {
  return (
    Number(
      await valkey.eval(
        REPLACE_UNLESS_DELETED,
        3,
        key(resourceShortId),
        deletedKey(resourceShortId),
        targetKey(resourceShortId),
        JSON.stringify(binding),
        binding.projectId === null
          ? ""
          : JSON.stringify({
              projectId: binding.projectId,
              ...(binding.functionArn === undefined ? {} : { functionArn: binding.functionArn }),
            }),
      ),
    ) === 1
  )
}

export async function readQueue(
  valkey: Redis,
  resourceShortId: string,
): Promise<QueueBinding | undefined> {
  const rows = (await valkey.eval(
    `
if redis.call('EXISTS', KEYS[2]) == 1 then return nil end
return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[3])}
`,
    3,
    key(resourceShortId),
    deletedKey(resourceShortId),
    targetKey(resourceShortId),
  )) as [string | null, string | null] | null
  const raw = rows?.[0] ?? null
  if (raw === null) return undefined
  try {
    const binding = JSON.parse(raw) as QueueBinding
    const target = rows?.[1] === null ? undefined : (JSON.parse(rows?.[1] ?? "") as QueueBinding)
    return target === undefined
      ? binding
      : { ...binding, projectId: target.projectId, functionArn: target.functionArn }
  } catch {
    return undefined
  }
}

/*
 * Move only the executable half of an existing queue binding.
 *
 * The URI is a credential and exists nowhere else in recoverable form. A deployment must therefore
 * update the binding in place rather than rebuilding it from Postgres. The compare-and-set is one
 * Valkey script because a credential rotation may replace the binding between our read and write;
 * a plain GET followed by SET would put the revoked URI back and silently undo the rotation.
 *
 * A missing binding stays missing. In particular, a deployment racing a service deletion must not
 * resurrect the credential after teardown withdrew it.
 */
const MOVE_TARGET = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if current ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
return 1
`

export async function setQueueTarget(
  valkey: Redis,
  resourceShortId: string,
  projectId: string,
  functionArn: string | null,
): Promise<boolean> {
  const bindingKey = key(resourceShortId)
  const tombstoneKey = deletedKey(resourceShortId)
  const authoritativeTargetKey = targetKey(resourceShortId)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await valkey.exists(tombstoneKey)) === 1) return false
    const raw = await valkey.get(bindingKey)
    if (raw === null) return false

    let current: QueueBinding
    try {
      current = JSON.parse(raw) as QueueBinding
    } catch {
      throw new Error(`Queue binding ${resourceShortId} is unreadable`)
    }
    if (
      typeof current.uri !== "string" ||
      typeof current.backendServiceId !== "string" ||
      typeof current.organizationId !== "string"
    ) {
      throw new Error(`Queue binding ${resourceShortId} is incomplete`)
    }
    if (current.projectId !== null && current.projectId !== projectId) {
      throw new Error(`Queue binding ${resourceShortId} belongs to another project`)
    }

    const next: QueueBinding = { ...current, projectId, functionArn: functionArn ?? undefined }
    // JSON.stringify omits the explicit `undefined`, which removes a stale function ARN while
    // keeping the one-time URI and the resource identity intact.
    const moved = Number(
      await valkey.eval(
        MOVE_TARGET,
        3,
        bindingKey,
        tombstoneKey,
        authoritativeTargetKey,
        raw,
        JSON.stringify(next),
        JSON.stringify({ projectId, ...(functionArn === null ? {} : { functionArn }) }),
      ),
    )
    if (moved === 1) return true
    if (moved === 0) return false
  }

  throw new Error(`Queue binding ${resourceShortId} kept changing while its target was updated`)
}

/**
 * Stop the router watching a queue, permanently.
 *
 * The marker contains no credential. Keeping it prevents a credential rotation that began before
 * deletion from publishing its late result after teardown. Backend service IDs are UUIDv7s and
 * never reused, so there is no valid operation that needs to recreate this exact key.
 */
export async function withdrawQueue(valkey: Redis, resourceShortId: string): Promise<void> {
  await valkey.eval(
    `
redis.call('SET', KEYS[2], '1')
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[3])
return 1
`,
    3,
    key(resourceShortId),
    deletedKey(resourceShortId),
    targetKey(resourceShortId),
  )
}
