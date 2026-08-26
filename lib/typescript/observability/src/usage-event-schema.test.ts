import { readFileSync } from "node:fs"
import { join } from "node:path"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { clickhouse, observabilityConfigured } from "./client"
import {
  usageEventMaterializedViewDdl,
  usageEventQueueDdl,
  usageEventRawDdl,
  usageEventStoredAtDdl,
} from "./schema"

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
  throw new Error("ClickHouse is not reachable in CI; usage-event schema tests must not skip")
}

describe("the raw usage-event schema", () => {
  it("keeps the boot schema identical to the schema installed on a fresh OVH host", () => {
    const path = join(import.meta.dirname, "../../../../ovh/clickhouse-init/02-usage-events.sql")
    const file = readFileSync(path, "utf8")
    const start = file.indexOf("create table if not exists sproutos.usage_event_raw")
    expect(start).toBeGreaterThan(0)

    const installed = file.slice(start)
    const runtime = [
      usageEventRawDdl("sproutos"),
      usageEventStoredAtDdl("sproutos"),
      usageEventQueueDdl("kafka:9092", "usage-events", "sproutos"),
      usageEventMaterializedViewDdl("sproutos"),
    ].join(";\n\n")

    expect(installed).toBe(`${runtime};\n`)
  })

  it("maps the normalized JSONEachRow wire fields without defaults or renaming", () => {
    const ddl = usageEventQueueDdl("kafka:9092", "usage-events")

    for (const field of [
      "event_id String",
      "organization_id UUID",
      "project_id Nullable(UUID)",
      "resource_type LowCardinality(String)",
      "resource_id Nullable(UUID)",
      "dimension LowCardinality(String)",
      "quantity Decimal(38, 9)",
      "occurred_at DateTime64(3, 'UTC')",
      "window_start Nullable(DateTime64(3, 'UTC'))",
      "window_end Nullable(DateTime64(3, 'UTC'))",
      "node_id Nullable(String)",
      "pod_uid Nullable(String)",
      "source String",
      "external_id String",
      "charged_externally Bool",
      "attributes Map(String, String)",
      "ingested_at DateTime64(3, 'UTC')",
      "version UInt64",
    ]) {
      expect(ddl).toContain(field)
    }
    expect(ddl).toContain("kafka_format = 'JSONEachRow'")
  })

  it("refuses configuration strings that could escape the Kafka settings", () => {
    expect(() => usageEventQueueDdl("kafka:9092'", "usage-events")).toThrow(/KAFKA_BROKERS/)
    expect(() => usageEventQueueDdl("kafka:9092", "usage-events'; drop table x")).toThrow(
      /KAFKA_USAGE_EVENT_TOPIC/,
    )
  })

  it("keeps Kafka authentication in environment-backed server configuration", () => {
    const path = join(import.meta.dirname, "../../../../ovh/clickhouse-config/usage-kafka.xml")
    const config = readFileSync(path, "utf8")

    expect(config).toContain('from_env="CLICKHOUSE_USAGE_KAFKA_SECURITY_PROTOCOL"')
    expect(config).toContain('from_env="CLICKHOUSE_USAGE_KAFKA_SASL_MECHANISM"')
    expect(config).toContain('from_env="CLICKHOUSE_USAGE_KAFKA_SASL_USERNAME"')
    expect(config).toContain('from_env="CLICKHOUSE_USAGE_KAFKA_SASL_PASSWORD"')
    expect(config).not.toMatch(/<sasl_(?:username|password)>[^<]+/)

    const ddl = usageEventQueueDdl("kafka.sproutos.me:9094", "usage-events")
    expect(ddl).not.toContain("sasl")
    expect(ddl).not.toContain("password")
  })
})

const eventId = "a".repeat(64)

afterAll(async () => {
  if (!reachable) return
  await clickhouse().command({
    query: `alter table usage_event_raw delete where event_id = '${eventId}'`,
    clickhouse_settings: { mutations_sync: "1" },
  })
  await clickhouse().close()
})

describe.runIf(reachable)("ReplacingMergeTree usage-event storage", () => {
  it("accepts the wire shape and selects the greatest deterministic version under FINAL", async () => {
    await clickhouse().command({ query: usageEventRawDdl() })

    const base = {
      event_id: eventId,
      organization_id: v7(),
      project_id: null,
      resource_type: "site",
      resource_id: null,
      dimension: "site_request",
      occurred_at: "2026-08-26 12:00:00.000",
      window_start: null,
      window_end: null,
      node_id: null,
      pod_uid: null,
      source: "schema-test",
      external_id: "request-1",
      charged_externally: false,
      attributes: { region: "us-east-1" },
      ingested_at: "2026-08-26 12:00:01.000",
    }

    await clickhouse().insert({
      table: "usage_event_raw",
      format: "JSONEachRow",
      values: [
        { ...base, quantity: "1.000000000", version: "1000" },
        { ...base, quantity: "2.000000000", version: "2000" },
      ],
    })

    const result = await clickhouse().query({
      query:
        `select toString(quantity) as quantity, toString(version) as version ` +
        `from usage_event_raw final where event_id = '${eventId}'`,
      format: "JSONEachRow",
    })
    const rows = await result.json<{ quantity: string; version: string }>()

    expect(rows).toEqual([{ quantity: "2", version: "2000" }])

    const metadata = await clickhouse().query({
      query:
        "select engine, sorting_key, partition_key from system.tables " +
        "where database = currentDatabase() and name = 'usage_event_raw'",
      format: "JSONEachRow",
    })
    expect(await metadata.json()).toEqual([
      {
        engine: "ReplacingMergeTree",
        sorting_key: "event_id",
        partition_key: "toYYYYMM(occurred_at)",
      },
    ])
  })
})
