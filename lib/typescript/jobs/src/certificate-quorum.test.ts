import { Redis } from "ioredis"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { certificateDeploymentQuorum, ROUTER_SERVING_REPLICAS_KEY } from "./certificate-quorum"

const CONNECTION = process.env.VALKEY_URL ?? "redis://localhost:41023"
const valkey = new Redis(CONNECTION, { lazyConnect: true, maxRetriesPerRequest: 1 })
const reachable = await (async () => {
  try {
    await valkey.connect()
    await valkey.ping()
    return true
  } catch {
    return false
  }
})()

const prefix = "test:cert-quorum:version:"
const keys = (replicas: string[]) => replicas.map((replica) => `${prefix}${replica}`)

beforeEach(async () => {
  if (!reachable) return
  const replicas = await valkey.zrange(ROUTER_SERVING_REPLICAS_KEY, "0", "-1")
  await valkey.del(ROUTER_SERVING_REPLICAS_KEY, ...keys(replicas))
})

afterAll(async () => {
  if (reachable) {
    const replicas = await valkey.zrange(ROUTER_SERVING_REPLICAS_KEY, "0", "-1")
    await valkey.del(ROUTER_SERVING_REPLICAS_KEY, ...keys(replicas))
  }
  valkey.disconnect()
})

describe.runIf(reachable)("certificate serving quorum", () => {
  it("refuses zero replicas and requires every live serving replica", async () => {
    const now = new Date("2026-08-28T12:00:00Z")
    expect(await certificateDeploymentQuorum(valkey, prefix, now)).toEqual({
      serving: 0,
      loaded: 0,
      ready: false,
    })

    await valkey.zadd(ROUTER_SERVING_REPLICAS_KEY, now.getTime() + 90_000, "blue-1")
    expect(await certificateDeploymentQuorum(valkey, prefix, now)).toMatchObject({
      serving: 1,
      loaded: 0,
      ready: false,
    })
    await valkey.set(`${prefix}blue-1`, "1", "EX", 90)
    expect(await certificateDeploymentQuorum(valkey, prefix, now)).toMatchObject({
      serving: 1,
      loaded: 1,
      ready: true,
    })
  })

  it("makes scale-out join the quorum before activation", async () => {
    const now = new Date("2026-08-28T12:00:00Z")
    await valkey.zadd(ROUTER_SERVING_REPLICAS_KEY, now.getTime() + 90_000, "blue-1")
    await valkey.set(`${prefix}blue-1`, "1", "EX", 90)
    expect((await certificateDeploymentQuorum(valkey, prefix, now)).ready).toBe(true)

    await valkey.zadd(ROUTER_SERVING_REPLICAS_KEY, now.getTime() + 90_000, "green-1")
    expect(await certificateDeploymentQuorum(valkey, prefix, now)).toMatchObject({
      serving: 2,
      loaded: 1,
      ready: false,
    })
    await valkey.set(`${prefix}green-1`, "1", "EX", 90)
    expect((await certificateDeploymentQuorum(valkey, prefix, now)).ready).toBe(true)
  })

  it("lets a stopped replica age out during a rolling restart", async () => {
    const now = new Date("2026-08-28T12:00:00Z")
    await valkey.zadd(
      ROUTER_SERVING_REPLICAS_KEY,
      now.getTime() - 1,
      "old-blue",
      now.getTime() + 90_000,
      "new-blue",
    )
    await valkey.set(`${prefix}old-blue`, "1", "EX", 90)
    await valkey.set(`${prefix}new-blue`, "1", "EX", 90)

    expect(await certificateDeploymentQuorum(valkey, prefix, now)).toEqual({
      serving: 1,
      loaded: 1,
      ready: true,
    })
    expect(await valkey.zrange(ROUTER_SERVING_REPLICAS_KEY, "0", "-1")).toEqual(["new-blue"])
  })

  it("takes membership and acknowledgements in one atomic server-side snapshot", async () => {
    const now = new Date("2026-08-28T12:00:00Z")
    await valkey.zadd(ROUTER_SERVING_REPLICAS_KEY, now.getTime() + 90_000, "blue-1")
    await valkey.set(`${prefix}blue-1`, "1", "EX", 90)

    // Repeated checks cannot observe the torn serving=1/loaded=0 state produced by separate SCANs
    // when no writer changes the snapshot. The Lua boundary evaluates expiry, members, and ACKs as
    // one Valkey command; concurrent heartbeats are ordered entirely before or after it.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => certificateDeploymentQuorum(valkey, prefix, now)),
    )
    expect(results.every((result) => result.ready && result.serving === 1)).toBe(true)
  })
})
