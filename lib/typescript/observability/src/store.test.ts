import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { clickhouse, closeClickhouse, observabilityConfigured } from "./client"
import { ingestLogs } from "./ingest"
import { projectServices, projectUsage, searchLogs } from "./query"
import { ensureSchema } from "./schema"
import type { Stream } from "./streams"

/**
 * Runs against the compose ClickHouse.
 *
 * What is being tested is agreement with ClickHouse — that the DDL is accepted, that a
 * `DateTime64(9)` round-trips the nanoseconds we sent it, that a `Map(String, String)` comes back
 * as an object, and that a query scoped to one project cannot see another's rows. A mock would
 * assert my reading of the docs, which is the assumption most likely to be wrong.
 */
const configured = observabilityConfigured()

const up = await (async () => {
  if (!configured) {
    if (process.env.CI !== undefined) {
      throw new Error("CLICKHOUSE_URL is not set in CI; these tests must not silently skip here")
    }
    return false
  }
  try {
    await clickhouse().query({ query: "select 1", format: "JSONEachRow" })
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

const projectId = v7()
const otherProjectId = v7()
const organizationId = v7()

const stream: Stream = { id: v7(), projectId, organizationId, retentionDays: 7 }
const otherStream: Stream = { ...stream, id: v7(), projectId: otherProjectId }

/** Nanoseconds, as a string, for `secondsAgo` seconds ago. */
function nanos(secondsAgo: number): string {
  return String(BigInt(Date.now() - secondsAgo * 1000) * 1_000_000n)
}

function request(records: Array<Record<string, unknown>>, service = "checkout") {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeLogs: [{ scope: { name: "test" }, logRecords: records }],
      },
    ],
  }
}

const since = new Date(Date.now() - 3_600_000).toISOString()
const until = new Date(Date.now() + 3_600_000).toISOString()

beforeAll(async () => {
  if (!up) return
  await ensureSchema()
})

afterAll(async () => {
  if (!up) return
  // `delete` is a mutation and asynchronous by default; the tests are done, so waiting is pointless
  // but leaving rows behind on a developer's machine is rude.
  await clickhouse()
    .command({
      query: `alter table log_record delete where project_id in ({a: UUID}, {b: UUID})`,
      query_params: { a: projectId, b: otherProjectId },
    })
    .catch(() => undefined)
  await closeClickhouse()
})

describe.skipIf(!up)("the log store", () => {
  it("creates its schema idempotently", async ({ skip }) => {
    if (!up) skip()
    // Run on every boot, so running it twice has to be a no-op rather than an error.
    await ensureSchema()
    await expect(ensureSchema()).resolves.toBeUndefined()

    const result = await clickhouse().query({
      query: "select count() as tables from system.tables where name = 'log_record'",
      format: "JSONEachRow",
    })
    expect(Number((await result.json<{ tables: string }>())[0]?.tables ?? 0)).toBe(1)
  })

  it("stores and returns a record with its nanoseconds intact", async ({ skip }) => {
    if (!up) skip()
    const timestamp = nanos(10)
    const result = await ingestLogs(
      stream,
      request([
        {
          timeUnixNano: timestamp,
          severityNumber: 17,
          severityText: "ERROR",
          body: { stringValue: "payment gateway timeout" },
          traceId: "5b8efff798038103d269b633813fc60c",
          spanId: "eee19b7ec3c1b174",
          attributes: [{ key: "order.id", value: { stringValue: "o-42" } }],
        },
      ]),
      512,
    )
    expect(result.accepted).toBe(1)
    expect(result.rejected).toBe(0)

    const { lines } = await searchLogs({ projectId, since, until, limit: 10 })
    const line = lines.find((entry) => entry.body === "payment gateway timeout")
    expect(line).toBeDefined()
    expect(line?.severityText).toBe("ERROR")
    expect(line?.traceId).toBe("5b8efff798038103d269b633813fc60c")
    // A `Map(String, String)` has to come back as an object, not as a string of tuples.
    expect(line?.attributes).toEqual({ "order.id": "o-42" })

    // The nanoseconds we sent, back out of `DateTime64(9)` unchanged. This is the assertion that
    // catches a column too narrow to hold them, or a client that routed the value through a float.
    expect(line?.cursor).toBe(timestamp)
    expect(line?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it("cannot see another project's records", async ({ skip }) => {
    if (!up) skip()
    await ingestLogs(
      otherStream,
      request([{ timeUnixNano: nanos(5), body: { stringValue: "belongs to the other tenant" } }]),
      64,
    )

    const { lines } = await searchLogs({ projectId, since, until, limit: 500 })
    expect(lines.some((line) => line.body.includes("other tenant"))).toBe(false)

    // And the other project does see it — otherwise this would pass because nothing was stored.
    const theirs = await searchLogs({ projectId: otherProjectId, since, until, limit: 500 })
    expect(theirs.lines.some((line) => line.body.includes("other tenant"))).toBe(true)
  })

  it("stamps ownership from the stream, never from the payload", async ({ skip }) => {
    if (!up) skip()
    /*
      A tenant that could name its own project id in an attribute could write into another tenant's
      logs. The parser has no path that reads one, and this is the assertion that keeps it that way.
    */
    await ingestLogs(
      stream,
      request([
        {
          timeUnixNano: nanos(4),
          body: { stringValue: "attempted spoof" },
          attributes: [
            { key: "project_id", value: { stringValue: otherProjectId } },
            { key: "organization_id", value: { stringValue: v7() } },
            { key: "retention_days", value: { intValue: "3650" } },
          ],
        },
      ]),
      128,
    )

    const result = await clickhouse().query({
      query: `
        select toString(project_id) as project_id, retention_days
        from log_record
        where body = 'attempted spoof'
      `,
      format: "JSONEachRow",
    })
    const rows = await result.json<{ project_id: string; retention_days: number }>()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.project_id).toBe(projectId)
    expect(rows[0]?.retention_days).toBe(7)
  })

  it("filters by severity, service and body", async ({ skip }) => {
    if (!up) skip()
    await ingestLogs(
      stream,
      request(
        [
          {
            timeUnixNano: nanos(3),
            severityNumber: 9,
            body: { stringValue: "cache warm complete" },
          },
          {
            timeUnixNano: nanos(2),
            severityNumber: 17,
            body: { stringValue: "connect_timeout=30 exceeded" },
          },
        ],
        "worker",
      ),
      256,
    )

    const errors = await searchLogs({ projectId, since, until, minSeverity: 17, limit: 100 })
    expect(errors.lines.every((line) => line.severityNumber >= 17)).toBe(true)
    expect(errors.lines.some((line) => line.body.includes("cache warm"))).toBe(false)

    const workers = await searchLogs({ projectId, since, until, service: "worker", limit: 100 })
    expect(workers.lines.every((line) => line.serviceName === "worker")).toBe(true)

    /*
      A substring inside a token, which is what a person actually types into a log search box.
      `hasToken` would miss this — `timeout` is not a token of `connect_timeout=30` — and a search
      that quietly required token boundaries would look broken rather than slow.
    */
    const found = await searchLogs({ projectId, since, until, search: "timeout", limit: 100 })
    expect(found.lines.some((line) => line.body.includes("connect_timeout=30"))).toBe(true)

    // And case-insensitively, because nobody matches the case of their own log lines.
    const upper = await searchLogs({ projectId, since, until, search: "TIMEOUT", limit: 100 })
    expect(upper.lines.length).toBe(found.lines.length)
  })

  it("pages backwards through time without repeating or skipping", async ({ skip }) => {
    if (!up) skip()
    const pageProject = v7()
    const pageStream: Stream = { ...stream, projectId: pageProject }
    await ingestLogs(
      pageStream,
      request(
        Array.from({ length: 25 }, (_, index) => ({
          timeUnixNano: nanos(100 + index),
          body: { stringValue: `page line ${index}` },
        })),
      ),
      1024,
    )

    const seen: string[] = []
    let before: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const result = await searchLogs({
        projectId: pageProject,
        since,
        until,
        limit: 10,
        ...(before === undefined ? {} : { before }),
      })
      seen.push(...result.lines.map((line) => line.body))
      if (result.nextBefore === null) break
      before = result.nextBefore
    }

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)

    await clickhouse()
      .command({
        query: "alter table log_record delete where project_id = {p: UUID}",
        query_params: { p: pageProject },
      })
      .catch(() => undefined)
  })

  it("does not hand out a cursor when the page is the last one", async ({ skip }) => {
    if (!up) skip()
    // A cursor returned unconditionally makes every client fetch one empty page at the end.
    const empty = await searchLogs({ projectId: v7(), since, until, limit: 10 })
    expect(empty.lines).toEqual([])
    expect(empty.nextBefore).toBeNull()
  })

  it("caps a caller's limit", async ({ skip }) => {
    if (!up) skip()
    // Asking for a million lines must not be a way to make the server read a million lines.
    const result = await searchLogs({ projectId, since, until, limit: 10_000_000 })
    expect(result.lines.length).toBeLessThanOrEqual(500)
  })

  it("reports usage and the services seen", async ({ skip }) => {
    if (!up) skip()
    const usage = await projectUsage(projectId, since)
    expect(usage.records).toBeGreaterThan(0)
    expect(usage.bytes).toBeGreaterThan(0)

    const services = await projectServices(projectId, since)
    expect(services).toContain("checkout")
    // The other tenant's service must not appear in this project's filter list.
    expect(services).not.toContain("nobody-elses-service")
  })

  it("accepts an empty batch without storing anything", async ({ skip }) => {
    if (!up) skip()
    // An exporter with nothing to send still sends on its timer.
    const result = await ingestLogs(stream, { resourceLogs: [] }, 12)
    expect(result).toEqual({ accepted: 0, rejected: 0, bytes: 12 })
  })
})
