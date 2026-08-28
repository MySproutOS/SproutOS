import type { Redis } from "ioredis"

/**
 * Live TLS-edge membership. Routers refresh their own expiry while their TLS listener is bound and
 * certificate inventory is healthy. A sorted set makes membership durable across worker restarts
 * while still letting a dead or replaced replica age out without a deregistration callback.
 */
export const ROUTER_SERVING_REPLICAS_KEY = "cert:serving-replicas"

export type CertificateQuorum = {
  serving: number
  loaded: number
  ready: boolean
}

const QUORUM_SCRIPT = `
local members_key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local ack_prefix = ARGV[2]
redis.call('ZREMRANGEBYSCORE', members_key, '-inf', now_ms)
local members = redis.call('ZRANGE', members_key, 0, -1)
local loaded = 0
for _, member in ipairs(members) do
  if redis.call('EXISTS', ack_prefix .. member) == 1 then
    loaded = loaded + 1
  end
end
return {#members, loaded}
`

/**
 * Take one atomic membership/acknowledgement snapshot.
 *
 * This intentionally has no configured minimum. A static number becomes unsafe on scale-out and
 * unavailable on scale-in. Activation requires every currently serving member to acknowledge the
 * exact immutable certificate version, and zero members is never a quorum.
 */
export async function certificateDeploymentQuorum(
  valkey: Redis,
  ackPrefix: string,
  now: Date,
): Promise<CertificateQuorum> {
  const result = await valkey.eval(
    QUORUM_SCRIPT,
    1,
    ROUTER_SERVING_REPLICAS_KEY,
    String(now.getTime()),
    ackPrefix,
  )
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error("Valkey returned an invalid certificate quorum result")
  }
  const values = result as unknown[]
  const serving = values[0]
  const loaded = values[1]
  if (
    typeof serving !== "number" ||
    !Number.isSafeInteger(serving) ||
    serving < 0 ||
    typeof loaded !== "number" ||
    !Number.isSafeInteger(loaded) ||
    loaded < 0
  ) {
    throw new Error("Valkey returned an invalid certificate quorum result")
  }
  return { serving, loaded, ready: serving > 0 && loaded === serving }
}
