import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import {
  ACTIVE_COUNTER_SCALE,
  activeUsageBucketKey,
  activeUsagePendingKey,
  applyActiveUsage,
  quantityToNanoUnits,
  readActiveUsage,
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
      version: "2054097906000",
    }
    const key = activeUsageBucketKey(event)

    expect(await applyActiveUsage(redis, event)).toBe("applied")
    expect(await applyActiveUsage(redis, event)).toBe("duplicate")
    expect(await readActiveUsage(redis, event)).toBe((3n * ACTIVE_COUNTER_SCALE).toString())
    expect(await redis.ttl(key)).toBeGreaterThan(0)

    const keys = await redis.keys(`metering:active:v2:{${event.organizationId}}:*`)
    if (keys.length > 0) await redis.unlink(...keys)
  })

  it("replaces an older ClickHouse version instead of double-counting it", async () => {
    const organizationId = crypto.randomUUID()
    const original: ActiveUsageEvent = {
      eventId: `test-${crypto.randomUUID()}`,
      organizationId,
      projectId: null,
      dimension: "site_request",
      quantity: 3,
      occurredAt: new Date("2035-02-03T04:05:06.000Z"),
      version: "2054097906000",
    }
    const corrected = {
      ...original,
      dimension: "site_gib_second",
      quantity: 5,
      version: "2054097907000",
    }

    expect(await applyActiveUsage(redis, original)).toBe("applied")
    expect(await applyActiveUsage(redis, corrected)).toBe("applied")
    expect(await applyActiveUsage(redis, original)).toBe("duplicate")
    expect(await readActiveUsage(redis, original)).toBe("0")
    expect(await readActiveUsage(redis, corrected)).toBe((5n * ACTIVE_COUNTER_SCALE).toString())

    const keys = await redis.keys(`metering:active:v2:{${organizationId}}:*`)
    if (keys.length > 0) await redis.unlink(...keys)
  })

  it("fails before growing the pending handoff beyond its configured bound", async () => {
    const organizationId = crypto.randomUUID()
    const first: ActiveUsageEvent = {
      eventId: `test-${crypto.randomUUID()}`,
      organizationId,
      projectId: null,
      dimension: "site_request",
      quantity: 1,
      occurredAt: new Date("2035-02-03T04:05:06.000Z"),
      version: "2054097908000",
    }
    const second = {
      ...first,
      eventId: `test-${crypto.randomUUID()}`,
      dimension: "site_gib_second",
    }

    try {
      await applyActiveUsage(redis, first, 1)
      await expect(applyActiveUsage(redis, second, 1)).rejects.toThrow(
        "active usage pending cardinality exceeds the configured limit",
      )
      expect(await readActiveUsage(redis, first)).toBe(ACTIVE_COUNTER_SCALE.toString())
      expect(await readActiveUsage(redis, second)).toBe("0")
      expect(await redis.hlen(activeUsagePendingKey(organizationId))).toBe(1)
    } finally {
      const keys = await redis.keys(`metering:active:v2:{${organizationId}}:*`)
      if (keys.length > 0) await redis.unlink(...keys)
    }
  })
})
