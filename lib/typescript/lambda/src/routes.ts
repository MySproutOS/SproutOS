import type { Redis } from "ioredis"

/**
 * The hostname → function map the Rust router reads on every request.
 *
 * This is the one piece of platform state on a per-request hot path, which is why it is in
 * ElastiCache and not Postgres. The control plane writes it when a deployment goes live; the router
 * only ever reads.
 *
 * **The router must be able to answer without this module.** The format is therefore deliberately
 * dumb — one string key holding JSON — because a Rust reader has to parse it and every cleverness
 * here becomes a second implementation over there that can disagree with this one.
 */

const PREFIX = "route:"

/**
 * How long the router may believe a route it has cached.
 *
 * Not a correctness bound — the control plane overwrites the key on every deploy, so a stale read
 * is at most one deploy behind. It is a garbage bound: a project deleted while the router was
 * partitioned would otherwise keep its route forever.
 */
export const ROUTE_TTL_S = 24 * 60 * 60

export type Route = {
  /** The alias ARN, so the router invokes whatever `live` currently points at. */
  arn: string
  projectId: string
  organizationId: string
  deploymentId: string
}

function key(hostname: string): string {
  // Lowercased because DNS is case-insensitive and a `Host` header is whatever the client typed.
  // Writing `App.sproutos.me` and reading `app.sproutos.me` is a 404 nobody can reproduce.
  return `${PREFIX}${hostname.toLowerCase()}`
}

/** Publish a route. Overwrites, because a deployment going live replaces whatever was there. */
export async function publishRoute(valkey: Redis, hostname: string, route: Route): Promise<void> {
  await valkey.set(key(hostname), JSON.stringify(route), "EX", ROUTE_TTL_S)
}

/** Read a route back. The router's own implementation of this is in Rust; this is for the tests. */
export async function readRoute(valkey: Redis, hostname: string): Promise<Route | undefined> {
  const raw = await valkey.get(key(hostname))
  if (raw === null) return undefined

  try {
    return JSON.parse(raw) as Route
  } catch {
    // A key that will not parse is a key written by something that is not this module. Treating it
    // as absent sends the request to a 404 rather than a 500, and the router does the same.
    return undefined
  }
}

/**
 * Withdraw a route, on teardown or suspension.
 *
 * Deleting the key is what actually stops a suspended project costing money: the function still
 * exists and would still run, so refusing to *route* to it is the enforcement point — the same
 * argument as refusing to resolve a suspended Postgres.
 */
export async function withdrawRoute(valkey: Redis, hostname: string): Promise<void> {
  await valkey.del(key(hostname))
}
