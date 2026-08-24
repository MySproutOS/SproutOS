import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import { publishRoute, readRoute, ROUTE_TTL_S, type Route, withdrawRoute } from "./routes"

/**
 * Against the compose Valkey. What matters is the bytes actually in the key — the Rust router reads
 * them, and a test that only round-trips through this module would agree with itself while the two
 * implementations disagreed.
 */
/*
  `VALKEY_URL`, not `SERVICE_VALKEY_ADMIN_URL`. The first is the platform's own Valkey — ElastiCache
  in production — which is where the route map, the billing counters and the router's queue live.
  The second is the shared instance tenant queues are on, self-hosted at OVH. Publishing routes into
  that one would put platform state on hardware customers' workloads share.
*/
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

const HOST = "myapp.sproutos.me"
const route: Route = {
  arn: "arn:aws:lambda:us-east-1:000000000000:function:sproutos-app-01a0:live",
  projectId: "01a03600-0000-7000-8000-00000000d1ce",
  organizationId: "01a03600-0000-7000-8000-00000000beef",
  deploymentId: "01a03600-0000-7000-8000-0000000000de",
}

afterAll(async () => {
  if (reachable) {
    await valkey.del(`route:${HOST}`, "route:broken.sproutos.me")
  }
  valkey.disconnect()
})

describe.runIf(reachable)("the route map", () => {
  it("round-trips a route and gives it a bounded life", async () => {
    await publishRoute(valkey, HOST, route)

    expect(await readRoute(valkey, HOST)).toEqual(route)

    // Bounded, so a project deleted while the writer was partitioned does not keep its hostname
    // resolving forever.
    const ttl = await valkey.ttl(`route:${HOST}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(ROUTE_TTL_S)
  })

  it("stores plain JSON under a lowercase key, because Rust has to read it", async () => {
    await publishRoute(valkey, HOST, route)

    // Read with the raw client, not through `readRoute`: this asserts the wire format the router
    // parses, which is the whole reason the format is one dumb string.
    const raw = await valkey.get(`route:${HOST}`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw ?? "")).toEqual(route)
  })

  it("resolves a host whatever case the client sent it in", async () => {
    await publishRoute(valkey, "MyApp.SproutOS.me", route)

    // DNS is case-insensitive and the `Host` header is whatever was typed. Writing one case and
    // reading another is a 404 nobody can reproduce.
    expect(await readRoute(valkey, "myapp.sproutos.me")).toEqual(route)
    expect(await readRoute(valkey, "MYAPP.SPROUTOS.ME")).toEqual(route)
  })

  it("treats an unparseable value as no route rather than an error", async () => {
    // Something that is not this module wrote the key. A 404 is recoverable; a 500 on every request
    // to that host until somebody notices is not.
    await valkey.set("route:broken.sproutos.me", "{not json")

    expect(await readRoute(valkey, "broken.sproutos.me")).toBeUndefined()
  })

  it("withdraws a route, which is what stops a suspended project serving", async () => {
    await publishRoute(valkey, HOST, route)
    await withdrawRoute(valkey, HOST)

    // The Lambda still exists and would still run. Refusing to route is the enforcement point.
    expect(await readRoute(valkey, HOST)).toBeUndefined()
  })
})
