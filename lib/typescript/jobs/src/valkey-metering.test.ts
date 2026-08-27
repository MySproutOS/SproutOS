import { usageEventId } from "@lib/metering"
import { tenantKeyPrefix } from "@lib/reaper"
import { valkeyKeyPrefix } from "@lib/services"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  meterValkeyQueues,
  sampleTenantValkeyMemory,
  sampledByteSeconds,
  VALKEY_METERING_MAX_GAP_MS,
} from "./valkey-metering"

const adminUrl = process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://127.0.0.1:41023"
const redis = new Redis(adminUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
const reachable = await (async () => {
  try {
    await redis.connect()
    await redis.ping()
    await sql`select 1`.execute(db)
    return true
  } catch {
    redis.disconnect()
    return false
  }
})()

const userId = v7()
const organizationId = v7()
const backendServiceId = v7()
const otherServiceId = v7()
const tenantPrefix = tenantKeyPrefix(backendServiceId)
const otherTenantPrefix = tenantKeyPrefix(otherServiceId)
const prefix = `${valkeyKeyPrefix(backendServiceId)}:`
const otherPrefix = `${valkeyKeyPrefix(otherServiceId)}:`

beforeAll(async () => {
  if (!reachable) return
  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
  await db
    .insertInto("user")
    .values({ id: userId, email: `valkey-meter-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Valkey Meter",
      slug: `valkey-meter-${organizationId.slice(-12)}`,
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "queue",
      kind: "valkey",
      status: "active",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  const keys = await redis.keys(`${tenantPrefix}*`)
  const otherKeys = await redis.keys(`${otherTenantPrefix}*`)
  if (keys.length > 0) await redis.unlink(...keys)
  if (otherKeys.length > 0) await redis.unlink(...otherKeys)
  await db
    .deleteFrom("meteringOutbox")
    .where(sql<boolean>`payload ->> 'resource_id' = ${backendServiceId}`)
    .execute()
  await db.deleteFrom("backendService").where("id", "=", backendServiceId).execute()
  await db.deleteFrom("organization").where("id", "=", organizationId).execute()
  await db.deleteFrom("user").where("id", "=", userId).execute()
  await redis.quit()
  await db.destroy()
})

describe("sampledByteSeconds", () => {
  it("preserves the exact half-millisecond integration as a plain decimal", () => {
    expect(sampledByteSeconds(1n, 2n, 1)).toBe("0.0015")
    expect(sampledByteSeconds(100n, 300n, 5_000)).toBe("1000")
  })
})

describe.skipIf(!reachable)("Valkey queue memory metering", () => {
  it("sums only the exact tenant queue prefix with full MEMORY USAGE sampling", async () => {
    const stringKey = `${prefix}jobs:1`
    const hashKey = `${prefix}jobs:meta`
    await redis.set(stringKey, "payload")
    await redis.hset(hashKey, "one", "a", "two", "b", "three", "c")
    await redis.set(`${tenantPrefix}ordinary-cache-key`, "same tenant, not a workflow queue")
    await redis.set(`${otherPrefix}jobs:1`, "other tenant")

    const stringBytes = await redis.call("MEMORY", "USAGE", stringKey, "SAMPLES", 0)
    const hashBytes = await redis.call("MEMORY", "USAGE", hashKey, "SAMPLES", 0)
    expect(await sampleTenantValkeyMemory(redis, backendServiceId)).toBe(
      BigInt(stringBytes as number) + BigInt(hashBytes as number),
    )
  })

  it("atomically emits only successfully bracketed intervals and resets after a gap", async () => {
    const firstAt = new Date("2099-01-01T00:00:00.000Z")
    expect(
      await meterValkeyQueues(db, adminUrl, {
        backendServiceIds: [backendServiceId],
        observedAt: firstAt,
        redis,
      }),
    ).toBe(0)
    const first = await db
      .selectFrom("valkeyMeteringState")
      .select(["memoryBytes", "sampledAt"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    await redis.rpush(`${prefix}jobs:wait`, "1", "2", "3")
    const secondAt = new Date(firstAt.getTime() + 5 * 60 * 1000)
    expect(
      await meterValkeyQueues(db, adminUrl, {
        backendServiceIds: [backendServiceId],
        observedAt: secondAt,
        redis,
      }),
    ).toBe(1)
    const second = await db
      .selectFrom("valkeyMeteringState")
      .select(["memoryBytes", "sampledAt"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    const rows = await sql<{ eventId: string; payload: string }>`
      select event_id as "eventId", payload::text as payload
      from metering_outbox
      where payload ->> 'resource_id' = ${backendServiceId}
    `.execute(db)
    const row = rows.rows[0]
    if (row === undefined) throw new Error("Valkey metering produced no outbox row")
    const payload = JSON.parse(row.payload) as Record<string, unknown>

    expect(payload.dimension).toBe("valkey_queue_byte_second")
    expect(payload.organization_id).toBe(organizationId)
    expect(payload.project_id).toBeNull()
    expect(payload.resource_id).toBe(backendServiceId)
    expect(payload.source).toBe("valkey-control-plane")
    expect(payload.window_start).toBe("2099-01-01 00:00:00.000")
    expect(payload.window_end).toBe("2099-01-01 00:05:00.000")
    expect(row.eventId).toBe(
      usageEventId({
        source: "valkey-control-plane",
        externalId: `${backendServiceId}:valkey_queue_byte_second:${firstAt.toISOString()}`,
        occurredAt: secondAt,
      }),
    )
    expect(payload.quantity).toBe(
      sampledByteSeconds(BigInt(first.memoryBytes), BigInt(second.memoryBytes), 5 * 60 * 1000),
    )

    expect(
      await meterValkeyQueues(db, adminUrl, {
        backendServiceIds: [backendServiceId],
        observedAt: secondAt,
        redis,
      }),
    ).toBe(0)
    expect(
      await db
        .selectFrom("meteringOutbox")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where(sql<boolean>`payload ->> 'resource_id' = ${backendServiceId}`)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" })

    const failedAt = new Date(secondAt.getTime() + 5 * 60 * 1000)
    await expect(
      meterValkeyQueues(db, "redis://127.0.0.1:1", {
        backendServiceIds: [backendServiceId],
        observedAt: failedAt,
      }),
    ).rejects.toThrow("Connection is closed")
    expect(
      (
        await db
          .selectFrom("valkeyMeteringState")
          .select("sampledAt")
          .where("backendServiceId", "=", backendServiceId)
          .executeTakeFirstOrThrow()
      ).sampledAt,
    ).toEqual(secondAt)

    const afterGap = new Date(secondAt.getTime() + VALKEY_METERING_MAX_GAP_MS + 1)
    expect(
      await meterValkeyQueues(db, adminUrl, {
        backendServiceIds: [backendServiceId],
        observedAt: afterGap,
        redis,
      }),
    ).toBe(0)
    expect(
      (
        await db
          .selectFrom("valkeyMeteringState")
          .select("sampledAt")
          .where("backendServiceId", "=", backendServiceId)
          .executeTakeFirstOrThrow()
      ).sampledAt,
    ).toEqual(afterGap)
  })
})
