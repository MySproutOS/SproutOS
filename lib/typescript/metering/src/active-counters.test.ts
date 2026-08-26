import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import {
  ACTIVE_COUNTER_SCALE,
  activeUsageBucketKey,
  activeUsageKeys,
  applyActiveUsage,
  quantityToNanoUnits,
  type ActiveUsageEvent,
} from "./active-counters"

describe("fixed-point usage quantities", () => {
  it.each([
    ["0", "0"],
    ["1", "1000000000"],
    ["0.25", "250000000"],
    [1e-9, "1"],
    ["1.2345678904", "1234567890"],
    ["1.2345678905", "1234567891"],
  ])("turns %s into nano-units", (quantity, expected) => {
    expect(quantityToNanoUnits(quantity)).toBe(expected)
  })

  it("refuses a value that would overflow HINCRBY", () => {
    expect(() => quantityToNanoUnits("9223372036.854775808")).toThrow(/signed 64-bit/)
  })
})

const url = process.env.VALKEY_URL ?? "redis://127.0.0.1:41023"
const redis = new Redis(url, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
})
let reachable = false
try {
  await redis.connect()
  await redis.ping()
  reachable = true
} catch {
  redis.disconnect()
}

afterAll(async () => {
  if (reachable) await redis.quit()
})

describe.skipIf(!reachable)("active usage projection", () => {
  it("increments once for a replayed event", async () => {
    const event: ActiveUsageEvent = {
      eventId: `test-${crypto.randomUUID()}`,
      organizationId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      dimension: "site_request",
      quantity: 3,
      occurredAt: new Date("2035-02-03T04:05:06.000Z"),
    }
    const key = activeUsageBucketKey(event)

    expect(await applyActiveUsage(redis, event)).toBe("applied")
    expect(await applyActiveUsage(redis, event)).toBe("duplicate")
    expect(await redis.hget(key, event.dimension)).toBe((3n * ACTIVE_COUNTER_SCALE).toString())
    expect(await redis.ttl(key)).toBeGreaterThan(0)

    await redis.del(...activeUsageKeys(event))
  })
})
