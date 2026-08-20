import { encodeShortId } from "@lib/services/tenant-auth"

/**
 * BullMQ's own key prefix, which it puts in front of every key it writes.
 *
 * `bull` is BullMQ's default and SproutOS does not change it, because SproutOS *generates* the
 * worker code for a workflow — the queue is created by code we wrote, so the prefix is not a
 * customer choice to discover. A queue a customer wrote by hand may use any prefix it likes, and
 * TASK 35 is about workflow jobs.
 */
export const BULLMQ_PREFIX = "bull"

/**
 * The prefix the control plane must use to reach one tenant's queue keys.
 *
 * A tenant's worker connects through `services/valkey-proxy`, which prepends `{kv:<short-id>}:` to
 * every key. Its BullMQ then prepends `bull`, so the key that actually exists in the shared Valkey
 * is:
 *
 * ```text
 * {kv:01j4pkz…}:bull:emails:42
 * ```
 *
 * The control plane connects to that Valkey **directly**, not through the proxy, so it has to apply
 * both halves itself. Going through the proxy is not an option even in principle: the tenant's
 * secret is stored as a one-way hash, so we cannot authenticate as them — which is the property
 * that makes a stolen credential table worthless, and worth keeping.
 */
export function tenantQueuePrefix(backendServiceId: string): string {
  return `{kv:${encodeShortId(backendServiceId)}}:${BULLMQ_PREFIX}`
}
