import { usageEventId, type UsageEventRecord } from "@lib/metering"
import type { NeonProjectConsumption } from "@lib/services"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  meterNeonDatabases,
  neonByteMonthsToGibHours,
  neonConsumptionCutoff,
} from "./neon-metering"

const reachable = await (async () => {
  try {
    await sql`select 1 from neon_metering_state limit 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const userId = v7()
const organizationId = v7()
const backendServiceId = v7()
const databaseInstanceId = v7()
const providerProjectId = "quiet-unit-test-123456"
const createdAt = new Date("2099-01-01T00:10:00.000Z")
const config = {
  apiKey: "test-key",
  apiUrl: "https://neon.invalid/api/v2",
  orgId: "org-test",
  regionId: "aws-us-east-1",
}

beforeAll(async () => {
  if (!reachable) return
  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
  await db
    .insertInto("user")
    .values({ id: userId, email: `neon-meter-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Neon Meter",
      slug: `neon-meter-${organizationId.slice(-12)}`,
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
      name: "database",
      kind: "postgres",
      status: "active",
    })
    .execute()
  await db
    .insertInto("databaseInstance")
    .values({
      id: databaseInstanceId,
      backendServiceId,
      projectId: null,
      provider: "neon",
      providerProjectId,
      status: "active",
      createdAt,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await db
    .deleteFrom("meteringOutbox")
    .where(sql<boolean>`payload ->> 'resource_id' = ${backendServiceId}`)
    .execute()
  await db.deleteFrom("backendService").where("id", "=", backendServiceId).execute()
  await db.deleteFrom("organization").where("id", "=", organizationId).execute()
  await db.deleteFrom("user").where("id", "=", userId).execute()
  await db.destroy()
})

describe("Neon consumption units", () => {
  it("uses only closed provider hours behind the refresh lag", () => {
    expect(neonConsumptionCutoff(new Date("2099-01-02T01:40:00.000Z"))).toEqual(
      new Date("2099-01-02T01:00:00.000Z"),
    )
  })

  it("converts exact byte-months to the price book's GiB-hours without floating point", () => {
    expect(neonByteMonthsToGibHours(1_073_741_824n)).toBe("730")
    expect(neonByteMonthsToGibHours(3n * 1_073_741_824n)).toBe("2190")
    expect(neonByteMonthsToGibHours(1n)).toMatch(/^0\.\d{9}$/)
  })
})

describe.skipIf(!reachable)("Neon consumption persistence", () => {
  it("atomically emits both provider dimensions and advances one durable watermark", async () => {
    const now = new Date("2099-01-02T01:40:00.000Z")
    let calls = 0
    let releaseBoth: (() => void) | undefined
    const bothCalled = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const client = {
      projectConsumption: async (input: { projectIds: string[]; from: Date; to: Date }) => {
        calls++
        if (calls === 2) releaseBoth?.()
        await bothCalled
        expect(input.projectIds).toEqual([providerProjectId])
        const start = new Date(input.to.getTime() - 3_600_000)
        return [
          {
            project_id: providerProjectId,
            periods: [
              {
                period_id: "79ec829f-1828-4006-ac82-9f1828a0067d",
                period_plan: "agent",
                period_start: "2099-01-01T00:00:00.000Z",
                consumption: [
                  {
                    timeframe_start: start.toISOString(),
                    timeframe_end: input.to.toISOString(),
                    metrics: [
                      { metric_name: "compute_unit_seconds", value: 7_200 },
                      { metric_name: "root_branch_bytes_month", value: 1_073_741_824 },
                      { metric_name: "child_branch_bytes_month", value: 2_147_483_648 },
                    ],
                  },
                ],
              },
            ],
          } satisfies NeonProjectConsumption,
        ]
      },
    }

    const results = await Promise.all([
      meterNeonDatabases(db, config, { now, client, backendServiceIds: [backendServiceId] }),
      meterNeonDatabases(db, config, { now, client, backendServiceIds: [backendServiceId] }),
    ])
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(2)
    expect(calls).toBe(2)

    const state = await db
      .selectFrom("neonMeteringState")
      .select("meteredThrough")
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    expect(state.meteredThrough).toEqual(new Date("2099-01-02T01:00:00.000Z"))

    const rows = await sql<{ eventId: string; payload: string }>`
      select event_id as "eventId", payload::text as payload
      from metering_outbox
      where payload ->> 'resource_id' = ${backendServiceId}
      order by payload ->> 'dimension'
    `.execute(db)
    expect(rows.rows).toHaveLength(2)
    const events = rows.rows.map((row) => ({
      ...row,
      value: JSON.parse(row.payload) as UsageEventRecord,
    }))
    const compute = events.find((event) => event.value.dimension === "db_compute_cu_second")
    const storage = events.find((event) => event.value.dimension === "db_storage_gib_hour")
    expect(compute?.value.quantity).toBe("7200")
    expect(storage?.value.quantity).toBe("2190")
    expect(storage?.value.attributes).toMatchObject({
      root_branch_bytes_month: "1073741824",
      child_branch_bytes_month: "2147483648",
      conversion: "byte_month*730/1073741824",
    })
    expect(compute?.eventId).toBe(
      usageEventId({
        source: "neon-consumption",
        externalId: `${backendServiceId}:db_compute_cu_second:2099-01-02T00:00:00.000Z`,
        occurredAt: new Date("2099-01-02T01:00:00.000Z"),
      }),
    )

    // The same closed hour is a no-op before it reaches the provider, not a second event whose
    // duplicate happens to be discarded later.
    expect(
      await meterNeonDatabases(db, config, {
        now,
        client,
        backendServiceIds: [backendServiceId],
      }),
    ).toBe(0)
    expect(calls).toBe(2)

    const failedAt = new Date("2099-01-02T02:40:00.000Z")
    await expect(
      meterNeonDatabases(db, config, {
        now: failedAt,
        backendServiceIds: [backendServiceId],
        client: {
          projectConsumption: () => Promise.reject(new Error("provider unavailable")),
        },
      }),
    ).rejects.toThrow("provider unavailable")
    expect(
      (
        await db
          .selectFrom("neonMeteringState")
          .select("meteredThrough")
          .where("backendServiceId", "=", backendServiceId)
          .executeTakeFirstOrThrow()
      ).meteredThrough,
    ).toEqual(state.meteredThrough)

    let staleCalls = 0
    await expect(
      meterNeonDatabases(db, config, {
        now: new Date(state.meteredThrough.getTime() + 170 * 3_600_000),
        backendServiceIds: [backendServiceId],
        client: {
          projectConsumption: () => {
            staleCalls++
            return Promise.resolve([])
          },
        },
      }),
    ).rejects.toThrow(/older than hourly history/)
    expect(staleCalls).toBe(0)
  })
})
