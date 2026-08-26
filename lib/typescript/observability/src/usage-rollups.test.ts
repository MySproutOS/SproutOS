import { createHash } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { clickhouse, observabilityConfigured } from "./client"
import { usageEventRawDdl, usageEventStoredAtDdl } from "./schema"
import { usageRollupsChangedBetween } from "./usage-rollups"

const reachable = await (async () => {
  if (!observabilityConfigured()) return false
  try {
    const result = await clickhouse().query({ query: "select 1", format: "JSONEachRow" })
    await result.json()
    return true
  } catch {
    return false
  }
})()

if (!reachable && process.env.CI !== undefined) {
  throw new Error("ClickHouse is not reachable in CI; usage rollup tests must not skip")
}

const run = crypto.randomUUID()
const eventIds = [0, 1].map((index) => createHash("sha256").update(`${run}:${index}`).digest("hex"))

afterAll(async () => {
  if (!reachable) return
  await clickhouse().command({
    query: "alter table usage_event_raw delete where event_id in {ids:Array(String)}",
    query_params: { ids: eventIds },
    clickhouse_settings: { mutations_sync: "1" },
  })
})

describe.runIf(reachable)("ClickHouse absolute usage rollups", () => {
  it("deduplicates replays and repairs an old event-time bucket", async () => {
    await clickhouse().command({ query: usageEventRawDdl() })
    await clickhouse().command({ query: usageEventStoredAtDdl() })
    const organizationId = crypto.randomUUID()
    const base = {
      organization_id: organizationId,
      project_id: null,
      resource_type: "site",
      resource_id: null,
      dimension: "site_request",
      occurred_at: "2030-04-05 06:07:08.000",
      window_start: null,
      window_end: null,
      node_id: null,
      pod_uid: null,
      source: "usage-rollup-test",
      charged_externally: false,
      attributes: {},
    }
    const first = {
      ...base,
      event_id: eventIds[0],
      external_id: "first",
      quantity: "2.000000000",
      ingested_at: "2035-02-01 00:00:01.000",
      stored_at: "2035-02-01 00:00:01.000",
      version: "2053900801000",
    }
    const second = {
      ...base,
      event_id: eventIds[1],
      external_id: "second",
      quantity: "3.000000000",
      charged_externally: true,
      ingested_at: "2035-02-01 00:00:02.000",
      stored_at: "2035-02-01 00:00:02.000",
      version: "2053900802000",
    }

    await clickhouse().insert({
      table: "usage_event_raw",
      format: "JSONEachRow",
      values: [first, second, second],
    })

    const rows = await usageRollupsChangedBetween(
      new Date("2035-02-01T00:00:00.000Z"),
      new Date("2035-02-01T00:00:03.000Z"),
    )

    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.bucket).toSorted()).toEqual(["day", "hour", "minute"])
    for (const row of rows) {
      expect(row.organizationId).toBe(organizationId)
      expect(row.projectId).toBeNull()
      expect(Number(row.quantity)).toBe(5)
      expect(Number(row.externallyChargedQuantity)).toBe(3)
      // Event time, not the 2035 ingestion time.
      expect(row.bucketStart.getUTCFullYear()).toBe(2030)
    }
  })
})
