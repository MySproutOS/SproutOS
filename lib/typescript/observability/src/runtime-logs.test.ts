import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { clickhouse, observabilityConfigured } from "./client"
import {
  levelOf,
  parseReport,
  projectIdFromLogGroup,
  queryRuntimeLogs,
  requestIdOf,
  toRows,
  writeRuntimeLogs,
} from "./runtime-logs"

/*
  The parsing is pure and runs anywhere. The round trip needs the compose ClickHouse, because the
  thing it asserts is that ClickHouse accepts the timestamp format and gives it back — which is
  precisely what a fake would agree with while production did not.
*/
const reachable = await (async () => {
  if (!observabilityConfigured()) return false
  try {
    await clickhouse().query({ query: "select 1", format: "JSONEachRow" })
    return true
  } catch {
    return false
  }
})()

const REPORT =
  "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 1.23 ms\t" +
  "Billed Duration: 2 ms\tMemory Size: 512 MB\tMax Memory Used: 78 MB\tInit Duration: 210.50 ms"

describe("reading a Lambda log line", () => {
  it("takes the project from the log group and refuses anything else", () => {
    const projectId = "01a03600-0000-7000-8000-00000000d1ce"

    expect(projectIdFromLogGroup(`/aws/lambda/sproutos-app-${projectId}`)).toBe(projectId)

    // Somebody else's function, or one of ours that is not a tenant app. A shipper that accepted
    // these would file the platform's own logs under a customer's project.
    expect(projectIdFromLogGroup("/aws/lambda/some-other-function")).toBeUndefined()
    expect(projectIdFromLogGroup("/aws/lambda/sproutos-router-e2e")).toBeUndefined()
    expect(projectIdFromLogGroup(`/aws/lambda/sproutos-app-${projectId}-suffix`)).toBeUndefined()
  })

  it("pulls the billing numbers out of the REPORT line", () => {
    const report = parseReport(REPORT)

    expect(report?.durationMs).toBe(1.23)
    expect(report?.billedMs).toBe(2)
    expect(report?.memoryMb).toBe(512)
    expect(report?.initMs).toBe(210.5)
    // There is no boolean anywhere saying "cold start" — the presence of Init Duration is the
    // signal, which is the whole reason this function exists rather than a field read.
    expect(report?.coldStart).toBe(true)
  })

  it("calls a warm invocation warm rather than unknown", () => {
    const warm = parseReport(
      "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 0.9 ms\t" +
        "Billed Duration: 1 ms\tMemory Size: 512 MB\tMax Memory Used: 80 MB",
    )

    expect(warm?.initMs).toBeUndefined()
    // `false`, not undefined: "not a cold start" is a fact, and a null would read as "we do not
    // know" in a cold-start ratio nobody could then trust.
    expect(warm?.coldStart).toBe(false)
  })

  it("is not fooled by a customer line that mentions REPORT", () => {
    expect(parseReport("INFO generating the monthly REPORT for tenant 4")).toBeUndefined()
  })

  it("files the runtime's own lines as platform, not as the customer's", () => {
    expect(levelOf("START RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd Version: $LATEST")).toBe(
      "platform",
    )
    expect(levelOf(REPORT)).toBe("platform")

    expect(levelOf("2026-08-24T10:00:00Z\tERROR\tconnection refused")).toBe("error")
    expect(levelOf("WARNING: deprecated call")).toBe("warn")
    expect(levelOf("CRITICAL: out of memory")).toBe("fatal")

    // Unrecognised is `info`, not dropped and not `error`. It is still a line the customer wants.
    expect(levelOf("just some output")).toBe("info")
  })

  it("leaves the request id empty rather than inventing one", () => {
    expect(requestIdOf(REPORT)).toBe("8a2f4b1c-0000-4000-8000-00000000abcd")
    // A viewer grouping by request shows these ungrouped, which is honest. A placeholder would put
    // every unattributed line in one fabricated request.
    expect(requestIdOf("some output with no marker")).toBe("")
  })
})

const projectId = v7()
const deploymentId = v7()

afterAll(async () => {
  if (!reachable) return
  await clickhouse().command({
    query: `alter table runtime_log delete where project_id = '${projectId}'`,
  })
  await clickhouse().close()
})

describe.runIf(reachable)("the round trip through ClickHouse", () => {
  it("writes a batch and reads it back with the numbers intact", async () => {
    const base = Date.now() - 60_000
    const rows = toRows(`/aws/lambda/sproutos-app-${projectId}`, deploymentId, [
      { timestamp: base, message: "START RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd" },
      { timestamp: base + 1, message: "INFO handling a request" },
      { timestamp: base + 2, message: "ERROR the upstream refused" },
      { timestamp: base + 3, message: REPORT },
    ])

    expect(rows).toHaveLength(4)
    await writeRuntimeLogs(rows)

    const back = await queryRuntimeLogs({ projectId })
    expect(back).toHaveLength(4)

    const report = back.find((row) => row.level === "platform" && row.billedMs !== undefined)
    expect(report?.billedMs).toBe(2)
    expect(report?.durationMs).toBeCloseTo(1.23, 2)
    expect(report?.coldStart).toBe(true)

    // Newest first: a log viewer opens on the most recent line, not the oldest.
    expect(back[0]?.ts.getTime()).toBeGreaterThanOrEqual(back[3]?.ts.getTime() ?? 0)
  })

  it("filters by level and by text", async () => {
    const errors = await queryRuntimeLogs({ projectId, level: "error" })
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("upstream refused")

    const found = await queryRuntimeLogs({ projectId, search: "UPSTREAM" })
    // Case-insensitive: a customer searching their logs types what they remember, not what they
    // logged.
    expect(found).toHaveLength(1)
  })

  it("does not let a search string reach ClickHouse as SQL", async () => {
    /*
      The one thing that must not happen. A log viewer takes this straight from a text box, and if
      it were interpolated the quote would end the string literal and the rest would run — against a
      client whose connection can read every project's logs.
    */
    const hostile = "' or 1=1 --"

    const rows = await queryRuntimeLogs({ projectId, search: hostile })

    // No rows, and no error: it was matched as text, which is what a bound parameter does.
    expect(rows).toHaveLength(0)
  })

  it("keeps one project's logs out of another's", async () => {
    const other = v7()
    expect(await queryRuntimeLogs({ projectId: other })).toHaveLength(0)
  })

  it("carries the three-day retention in the table", async () => {
    /*
      The Terms of Service promise three days, so this is a claim to a customer and not a tuning
      knob. Asserted against `system.tables` rather than by grepping the DDL we wrote: ClickHouse
      rewrites `interval 3 day` to `toIntervalDay(3)`, and a check looking for the literal we typed
      reported a missing TTL on a table that had one. That happened.
    */
    const result = await clickhouse().query({
      query:
        "select engine_full from system.tables where database = currentDatabase() and name = 'runtime_log'",
      format: "JSONEachRow",
    })
    const [table] = await result.json<{ engine_full: string }>()

    expect(table?.engine_full).toContain("toIntervalDay(3)")
    // Whole partitions dropped rather than rows rewritten: expiry is a metadata operation, and the
    // cost is that retention lands between three and four days rather than exactly three.
    expect(table?.engine_full).toContain("ttl_only_drop_parts = 1")
  })

  it("caps what one request can ask for", async () => {
    // A viewer that asked for a million rows would hold the connection until it timed out.
    const rows = await queryRuntimeLogs({ projectId, limit: 1_000_000 })
    expect(rows.length).toBeLessThanOrEqual(1000)
  })
})
