import { Redis } from "ioredis"
import { encodeShortId } from "@lib/services/tenant-auth"

/**
 * Deleting one tenant's keys from the shared Valkey.
 *
 * `destroy` on the Valkey driver revokes the credential, which makes the tenant's keys
 * *unreachable* — the prefix is derived from the service id and no other tenant can name it. This
 * is what makes them *gone*, which is a different promise and the one a deletion request actually
 * makes.
 *
 * The keyspace is namespaced `{kv:<short-id>}:`, with the braces marking a Valkey Cluster hash tag,
 * so every key a tenant owns hashes to one slot. That was chosen so a tenant's `MULTI` and Lua
 * scripts stay legal on a cluster — but it pays off a second time here, and the two paths below are
 * that payoff.
 */

/** The namespace `services/valkey-proxy` prepends to every command it forwards. */
export function tenantKeyPrefix(backendServiceId: string): string {
  return `{kv:${encodeShortId(backendServiceId)}}:`
}

export type PurgeKeysResult = {
  /** How many keys were handed to `UNLINK`. */
  deleted: number
  /** `slot` when the cluster path ran, `scan` when it did not. */
  strategy: "slot" | "scan"
}

/**
 * How many keys to name in one `UNLINK`.
 *
 * Valkey handles one command at a time, so a single `UNLINK` over a hundred thousand keys is a
 * hundred thousand dictionary deletes with every other tenant waiting behind them. Batching keeps
 * each command short enough that the instance stays responsive while a large tenant is reaped.
 */
const BATCH = 500

/**
 * Delete every key under one tenant's namespace.
 *
 * `UNLINK` rather than `DEL`: both remove the key from the keyspace immediately, but `DEL` also
 * frees the value on the main thread, so deleting one tenant's large hash blocks every other
 * tenant's commands for as long as the free takes. `UNLINK` hands the free to a background thread.
 * On a shared instance that is the difference between a reap nobody notices and a latency spike
 * every customer sees.
 */
export async function purgeTenantKeys(
  redis: Redis,
  backendServiceId: string,
): Promise<PurgeKeysResult> {
  const prefix = tenantKeyPrefix(backendServiceId)

  return (await clusterEnabled(redis))
    ? { deleted: await purgeBySlot(redis, prefix), strategy: "slot" }
    : { deleted: await purgeByScan(redis, prefix), strategy: "scan" }
}

/**
 * The cluster path: ask the node which keys are in the tenant's slot.
 *
 * All of a tenant's keys hash to one slot, because the hash tag is the whole of the part between
 * the braces. `CLUSTER GETKEYSINSLOT` reads that slot's key index directly, so the work is
 * proportional to the keys being deleted rather than to the keyspace they sit in.
 *
 * **The prefix check below is not redundant.** There are 16384 slots and rather more tenants than
 * that, so two namespaces routinely share a slot — `CLUSTER GETKEYSINSLOT` would happily hand back
 * a different customer's keys, and this function would happily delete them. The slot narrows the
 * search; the prefix is what decides.
 */
async function purgeBySlot(redis: Redis, prefix: string): Promise<number> {
  // Ask the server for the slot rather than implementing CRC16 here. The mapping is the server's
  // to define, and a divergence between our idea of it and the cluster's would search the wrong
  // slot — which, given the prefix check, means deleting nothing and reporting success.
  const slot = Number(await redis.call("CLUSTER", "KEYSLOT", `${prefix}probe`))

  let deleted = 0
  /*
    `GETKEYSINSLOT` has no cursor. Every call returns the first `window` keys of the slot from the
    beginning, so paging is not available and the window has to be widened instead.

    Deleting is what makes progress: keys we removed are not in the next call's answer. The window
    only has to grow when a call comes back with a full page containing none of ours, which means
    another tenant's keys occupy the whole of the range we looked at and ours, if any, are behind
    them. Doubling from there reaches the end of the slot in log(n) calls, and the window resets
    once we start deleting again so the common case stays cheap.
  */
  let window = BATCH

  for (;;) {
    const total = Number(await redis.call("CLUSTER", "COUNTKEYSINSLOT", slot))
    if (total === 0) break

    const keys = (await redis.call("CLUSTER", "GETKEYSINSLOT", slot, window)) as string[]
    const ours = keys.filter((key) => key.startsWith(prefix))

    if (ours.length > 0) {
      await redis.unlink(...ours)
      deleted += ours.length
      window = BATCH
      continue
    }

    // Seen the whole slot without finding one of ours: there are none left.
    if (keys.length >= total) break
    window *= 2
  }

  return deleted
}

/**
 * The standalone path: walk the keyspace.
 *
 * `SCAN` filters with `MATCH` *after* reading each key from the table, so this is proportional to
 * every key on the instance and not just the tenant's. That is acceptable precisely because it is a
 * background job with no one waiting on it, and unavoidable on a single node: without cluster slots
 * there is no index from a key prefix to the keys under it.
 *
 * `COUNT` is a hint about how much work `SCAN` does per call, not a page size — a call may return
 * more or fewer keys, and an empty page does not mean the walk is over. Only a zero cursor does.
 */
async function purgeByScan(redis: Redis, prefix: string): Promise<number> {
  let cursor = "0"
  let deleted = 0

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", BATCH)
    cursor = next

    if (keys.length > 0) {
      await redis.unlink(...keys)
      deleted += keys.length
    }
  } while (cursor !== "0")

  return deleted
}

async function clusterEnabled(redis: Redis): Promise<boolean> {
  const info = await redis.info("cluster")
  return /^cluster_enabled:1/m.test(info)
}
