import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { clickhouse, observabilityConfigured } from "./client"
import { connectProducer, encode, type LogProducer } from "./producer"
import { queryRuntimeLogs, toRows } from "./runtime-logs"
import { ensureSchema } from "./schema"

/**
 * The whole log path, end to end: produce to Kafka, and read it back out of ClickHouse.
 *
 * Nothing in this file talks to ClickHouse to *write*. That is the property under test — the rows
 * arrive because a `Kafka` engine table consumed them and a materialized view pushed them into
 * `runtime_log`, which is a thing only a real broker and a real ClickHouse can demonstrate.
 */
const BROKERS = (process.env.KAFKA_BROKERS_HOST ?? "localhost:29092").split(",")

const reachable = await (async () => {
  if (!observabilityConfigured()) return false
  try {
    await clickhouse().query({ query: "select 1", format: "JSONEachRow" })
    const tables = await clickhouse().query({
      query: "select name from system.tables where database = currentDatabase()",
      format: "JSONEachRow",
    })
    const names = (await tables.json<{ name: string }>()).map((row) => row.name)
    // The consumer is only created where a broker is configured, so its absence means this
    // deployment does not consume from Kafka and the suite has nothing to assert.
    if (!names.includes("runtime_log_queue")) return false

    const probe = await connectProducer(BROKERS)
    await probe.disconnect()
    return true
  } catch {
    return false
  }
})()

const projectId = v7()
const deploymentId = v7()
let producer: LogProducer | undefined

afterAll(async () => {
  await producer?.disconnect()
  if (!reachable) return
  await clickhouse().command({
    query: `alter table runtime_log delete where project_id = '${projectId}'`,
  })
  await clickhouse().close()
})

describe("the wire form", () => {
  it("names the columns ClickHouse expects", () => {
    const [row] = toRows(`/aws/lambda/sproutos-app-${projectId}`, deploymentId, [
      { timestamp: 1_800_000_000_000, message: "INFO hello" },
    ])

    const encoded = JSON.parse(encode(row)) as Record<string, unknown>

    // `JSONEachRow` matches column names exactly, so a camelCase key is a column ClickHouse
    // silently ignores — the row arrives with that field empty and nothing says why.
    expect(Object.keys(encoded).sort()).toEqual([
      "billed_ms",
      "cold_start",
      "deployment_id",
      "duration_ms",
      "ingest_id",
      "ingested_at",
      "init_ms",
      "level",
      "memory_mb",
      "message",
      "project_id",
      "request_id",
      "ts",
    ])
    // Not an ISO string: DateTime64(3) does not parse the `T` and the `Z`.
    expect(encoded.ts).toBe("2027-01-15 08:00:00.000")
  })
})

describe.runIf(reachable)("through the broker", () => {
  it("arrives in ClickHouse without anything inserting it", async () => {
    producer = await connectProducer(BROKERS)
    // Other schema assertions run in parallel and exercise the boot-time Kafka table refresh.
    // Re-establish the current projection immediately before this end-to-end producer proof.
    await ensureSchema()

    const base = Date.now() - 30_000
    const rows = toRows(`/aws/lambda/sproutos-app-${projectId}`, deploymentId, [
      { timestamp: base, message: "INFO produced to kafka" },
      {
        timestamp: base + 1,
        message:
          "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 1.5 ms\t" +
          "Billed Duration: 2 ms\tMemory Size: 512 MB\tMax Memory Used: 40 MB",
      },
    ])

    await producer.send(rows)

    // ClickHouse consumes on its own schedule, so this polls rather than sleeping a fixed time —
    // a fixed sleep is either flaky or slow, and usually both on a loaded machine.
    let seen: Awaited<ReturnType<typeof queryRuntimeLogs>> = []
    for (let attempt = 0; attempt < 30; attempt += 1) {
      seen = await queryRuntimeLogs({ projectId })
      if (seen.length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    expect(seen).toHaveLength(2)

    // The billing fields survive the round trip. These are what the customer is charged from, so a
    // null here is money the platform silently does not collect.
    const report = seen.find((row) => row.billedMs !== undefined)
    expect(report?.billedMs).toBe(2)
    expect(report?.memoryMb).toBe(512)
    expect(report?.coldStart).toBe(false)
  }, 60_000)
})
