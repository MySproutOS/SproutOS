import { createHash } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { activeUsageEventsPage } from "./active-usage"
import { clickhouse, observabilityConfigured } from "./client"
import { usageEventRawDdl, usageEventStoredAtDdl } from "./schema"

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
  throw new Error("ClickHouse is not reachable in CI; active usage query tests must not skip")
}

const run = crypto.randomUUID()
const eventIds = ["a", "b"].map((suffix) =>
  createHash("sha256").update(`${run}:${suffix}`).digest("hex"),
)

afterAll(async () => {
  if (!reachable) return
  await clickhouse().command({
    query: "alter table usage_event_raw delete where event_id in {ids:Array(String)}",
    query_params: { ids: eventIds },
    clickhouse_settings: { mutations_sync: "1" },
  })
})

describe.runIf(reachable)("authoritative active usage pages", () => {
  it("keyset-pages FINAL rows and returns only the newest correction", async () => {
    await clickhouse().command({ query: usageEventRawDdl() })
    await clickhouse().command({ query: usageEventStoredAtDdl() })
    const organizationId = crypto.randomUUID()
    const base = {
      organization_id: organizationId,
      project_id: null,
      resource_type: "site",
      resource_id: null,
      occurred_at: "2035-02-03 04:05:06.000",
      window_start: null,
      window_end: null,
      node_id: null,
      pod_uid: null,
      source: "active-usage-test",
      charged_externally: false,
      attributes: {},
    }
    await clickhouse().insert({
      table: "usage_event_raw",
      format: "JSONEachRow",
      values: [
        {
          ...base,
          event_id: eventIds[0],
          external_id: "corrected",
          dimension: "site_request",
          quantity: "2.000000000",
          ingested_at: "2035-02-03 04:05:07.000",
          stored_at: "2035-02-03 04:05:07.000",
          version: "2054097907000",
        },
        {
          ...base,
          event_id: eventIds[0],
          external_id: "corrected",
          dimension: "site_gib_second",
          quantity: "4.000000000",
          ingested_at: "2035-02-03 04:05:08.000",
          stored_at: "2035-02-03 04:05:08.000",
          version: "2054097908000",
        },
        {
          ...base,
          event_id: eventIds[1],
          external_id: "second",
          dimension: "site_request",
          quantity: "3.000000000",
          ingested_at: "2035-02-03 04:05:09.000",
          stored_at: "2035-02-03 04:05:09.000",
          version: "2054097909000",
        },
      ],
    })

    const first = await activeUsageEventsPage(
      organizationId,
      new Date("2035-02-01T00:00:00.000Z"),
      "",
      1,
    )
    const second = await activeUsageEventsPage(
      organizationId,
      new Date("2035-02-01T00:00:00.000Z"),
      first[0].eventId,
      1,
    )

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect([...first, ...second].map((row) => row.eventId)).toEqual(eventIds.toSorted())
    expect([...first, ...second].find((row) => row.eventId === eventIds[0])).toMatchObject({
      dimension: "site_gib_second",
      quantity: "4",
      version: "2054097908000",
    })
  })
})
