import {
  ACTIVE_COUNTER_SCALE,
  activeUsageBucketKey,
  activeUsageControlKey,
  activeUsageEventKey,
  applyActiveUsage,
  readActiveUsage,
  type ActiveUsageEvent,
} from "@lib/metering"
import { Redis } from "ioredis"
import { afterAll, describe, expect, it } from "vitest"
import {
  reconcileActiveUsageOrganization,
  type ActiveUsagePageSource,
} from "./active-usage-reconciliation"

const redis = new Redis(process.env.VALKEY_URL ?? "redis://127.0.0.1:41023", {
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

if (!reachable && process.env.CI !== undefined) {
  throw new Error("Valkey is not reachable in CI; active usage reconciliation tests must not skip")
}

afterAll(async () => {
  if (reachable) await redis.quit()
})

function usage(
  organizationId: string,
  eventId: string,
  quantity: number,
  version: string,
  dimension = "site_request",
): ActiveUsageEvent {
  return {
    eventId,
    organizationId,
    projectId: null,
    dimension,
    quantity,
    occurredAt: new Date("2035-02-03T04:05:06.000Z"),
    version,
  }
}

function source(rows: ActiveUsageEvent[]): ActiveUsagePageSource {
  return (_organizationId, _since, afterEventId, limit) =>
    Promise.resolve(rows.filter((row) => row.eventId > afterEventId).slice(0, limit))
}

async function clean(organizationId: string): Promise<void> {
  const keys = await redis.keys(`metering:active:v2:{${organizationId}}:*`)
  if (keys.length > 0) await redis.unlink(...keys)
}

describe.skipIf(!reachable)("active usage reconciliation", () => {
  it("rebuilds a partially evicted bucket from ClickHouse", async () => {
    const organizationId = crypto.randomUUID()
    const first = usage(organizationId, "event-a", 2, "10")
    const second = usage(organizationId, "event-b", 3, "11")
    try {
      await applyActiveUsage(redis, first)
      await applyActiveUsage(redis, second)
      expect(await readActiveUsage(redis, first)).toBe((5n * ACTIVE_COUNTER_SCALE).toString())

      // Independent allkeys-lru eviction of a marker lets an ordinary retry over-count the live
      // generation. Reconciliation must not trust either half of that partially retained cache.
      await redis.unlink(activeUsageEventKey(organizationId, "bootstrap", first.eventId))
      await applyActiveUsage(redis, first)
      expect(await readActiveUsage(redis, first)).toBe((7n * ACTIVE_COUNTER_SCALE).toString())

      await redis.unlink(activeUsageBucketKey(first))
      expect(await readActiveUsage(redis, first)).toBe("0")

      const report = await reconcileActiveUsageOrganization(
        redis,
        organizationId,
        source([first, second]),
      )
      expect(report.clickhouseEvents).toBe(2)
      expect(report.pendingEvents).toBe(0)
      expect(await readActiveUsage(redis, first)).toBe((5n * ACTIVE_COUNTER_SCALE).toString())
    } finally {
      await clean(organizationId)
    }
  })

  it("represents the newest corrected ClickHouse version", async () => {
    const organizationId = crypto.randomUUID()
    const original = usage(organizationId, "event-correction", 3, "20")
    const corrected = usage(organizationId, original.eventId, 4, "21", "site_gib_second")
    try {
      await applyActiveUsage(redis, original)
      await reconcileActiveUsageOrganization(redis, organizationId, source([corrected]))

      expect(await readActiveUsage(redis, original)).toBe("0")
      expect(await readActiveUsage(redis, corrected)).toBe((4n * ACTIVE_COUNTER_SCALE).toString())
    } finally {
      await clean(organizationId)
    }
  })

  it("does not let an older rebuild overwrite concurrent ingest", async () => {
    const organizationId = crypto.randomUUID()
    const older = usage(organizationId, "event-race", 4, "30")
    const concurrent = usage(organizationId, older.eventId, 7, "31")
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const sourceStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const delayed: ActiveUsagePageSource = async (_organizationId, _since, afterEventId) => {
      if (afterEventId !== "") return []
      started()
      await blocked
      return [older]
    }

    try {
      const rebuilding = reconcileActiveUsageOrganization(redis, organizationId, delayed)
      await sourceStarted
      await applyActiveUsage(redis, concurrent)
      release()
      await rebuilding

      expect(await readActiveUsage(redis, concurrent)).toBe((7n * ACTIVE_COUNTER_SCALE).toString())
    } finally {
      release()
      await clean(organizationId)
    }
  })

  it("fails visibly and leaves the live generation in place at the cardinality bound", async () => {
    const organizationId = crypto.randomUUID()
    const live = usage(organizationId, "event-live", 2, "40")
    const extra = usage(organizationId, "event-z", 3, "41")
    try {
      await applyActiveUsage(redis, live)
      await expect(
        reconcileActiveUsageOrganization(redis, organizationId, source([live, extra]), {
          pageSize: 1,
          maximumEvents: 1,
          maximumGenerationKeys: 10,
        }),
      ).rejects.toThrow("cardinality exceeds the configured limit of 1")
      expect(await redis.hget(activeUsageControlKey(organizationId), "building")).toBeNull()
      expect(await readActiveUsage(redis, live)).toBe((2n * ACTIVE_COUNTER_SCALE).toString())
    } finally {
      await clean(organizationId)
    }
  })
})
