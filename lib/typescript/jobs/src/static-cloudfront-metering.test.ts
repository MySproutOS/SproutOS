import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import {
  importStaticCloudFrontLog,
  parseStaticCloudFrontLog,
  reconcileStaticCloudFrontUsage,
  scanStaticCloudFrontLogs,
  staticCloudFrontObjectIdempotencyKey,
  staticCloudFrontUsageEvents,
} from "./static-cloudfront-metering"

const LOG = [
  "#Version: 1.0",
  "#Fields: x-host-header sc-bytes timestamp(ms) x-edge-request-id date time",
  "STATIC-APP.SPROUTOS.RUN%2E\t12345\t1787913296789\treq-stable-1\t2026-08-28\t12:34:56",
  "unknown.sproutos.run\t7\t1787913297000\treq-unknown\t2026-08-28\t12:34:57",
  "",
].join("\n")

describe("static CloudFront metering", () => {
  it("parses selected W3C fields by name and keeps CloudFront's observed timestamp", () => {
    expect(parseStaticCloudFrontLog(LOG)).toEqual([
      {
        bytes: "12345",
        hostname: "static-app.sproutos.run",
        occurredAt: new Date(1_787_913_296_789),
        requestId: "req-stable-1",
        routePrefix: null,
      },
      {
        bytes: "7",
        hostname: "unknown.sproutos.run",
        occurredAt: new Date(1_787_913_297_000),
        requestId: "req-unknown",
        routePrefix: null,
      },
    ])
  })

  it("builds distinct, retry-stable request and egress identities from the CloudFront request id", () => {
    const requests = parseStaticCloudFrontLog(LOG)
    const attribution = new Map([
      [
        "static-app.sproutos.run",
        {
          deploymentId: "019c0000-0000-7000-8000-000000000001",
          organizationId: "019c0000-0000-7000-8000-000000000002",
          projectId: "019c0000-0000-7000-8000-000000000003",
        },
      ],
    ])
    const first = staticCloudFrontUsageEvents(
      requests,
      attribution,
      "tenant-static/2026/08/28/a.gz",
    )
    const retried = staticCloudFrontUsageEvents(
      requests,
      attribution,
      "tenant-static/2026/08/28/a.gz",
    )

    expect(first).toEqual(retried)
    expect(first.map(({ dimension, quantity }) => ({ dimension, quantity }))).toEqual([
      { dimension: "site_request", quantity: "1" },
      { dimension: "site_egress_byte", quantity: "12345" },
    ])
    expect(new Set(first.map((event) => event.eventId)).size).toBe(2)
    expect(first[0]?.occurredAt).toEqual(new Date(1_787_913_296_789))
    expect(first[0]?.attributes.cloudfront_request_id).toBe("req-stable-1")
    expect(first.every((event) => event.source === "cloudfront-standard-v2")).toBe(true)
  })

  it("uses the logged immutable project/digest route when a hostname has since moved", () => {
    const routePrefix = `019c0000-0000-7000-8000-000000000003/${"a".repeat(64)}`
    const [request] = parseStaticCloudFrontLog(
      [
        "#Fields: timestamp(ms) x-edge-request-id x-host-header sc-bytes viewer-request-log-data",
        `1787913296789\treq-original\tmoved.example\t42\t${routePrefix.replace("/", "%2F")}`,
      ].join("\n"),
    )
    if (request === undefined) throw new Error("fixture did not parse")
    const events = staticCloudFrontUsageEvents(
      [request],
      new Map([
        [
          routePrefix,
          {
            deploymentId: "019c0000-0000-7000-8000-000000000004",
            organizationId: "019c0000-0000-7000-8000-000000000005",
            projectId: "019c0000-0000-7000-8000-000000000003",
          },
        ],
        [
          "moved.example",
          {
            deploymentId: "019c0000-0000-7000-8000-000000000006",
            organizationId: "019c0000-0000-7000-8000-000000000007",
            projectId: "019c0000-0000-7000-8000-000000000008",
          },
        ],
      ]),
      "tenant-static/2026/08/28/a.gz",
    )

    expect(request.routePrefix).toBe(routePrefix)
    expect(events[0]?.projectId).toBe("019c0000-0000-7000-8000-000000000003")
    expect(events[0]?.resourceId).toBe("019c0000-0000-7000-8000-000000000004")
  })

  it("imports gzip objects and emits the same canonical rows on a retry", async () => {
    const batches: unknown[][] = []
    const handler = importStaticCloudFrontLog({
      config: { bucket: "logs", prefix: "tenant-static/" },
      get: (input) => {
        expect(input).toMatchObject({
          Bucket: "logs",
          Key: "tenant-static/2026/08/28/a.gz",
          IfMatch: '"etag"',
        })
        return Promise.resolve({ Body: gzipSync(LOG), $metadata: {} })
      },
      resolveAttribution: (_db, requests) => {
        expect(requests.map((request) => request.hostname)).toEqual([
          "static-app.sproutos.run",
          "unknown.sproutos.run",
        ])
        return Promise.resolve(
          new Map([
            [
              "static-app.sproutos.run",
              {
                deploymentId: "019c0000-0000-7000-8000-000000000001",
                organizationId: "019c0000-0000-7000-8000-000000000002",
                projectId: "019c0000-0000-7000-8000-000000000003",
              },
            ],
          ]),
        )
      },
      storeEvents: (_db, events) => {
        batches.push(events)
        return Promise.resolve()
      },
    })
    const job = {
      payload: { key: "tenant-static/2026/08/28/a.gz", etag: '"etag"' },
    } as never
    const context = {
      db: {},
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    } as never

    await handler(job, context)
    await handler(job, context)

    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual(batches[1])
  })

  it("backfills the full retained window before creating its first cursor", async () => {
    const prefixes: string[] = []
    const advanced: Date[] = []
    const scanStart = new Date("2026-08-28T12:01:00.000Z")
    const handler = scanStaticCloudFrontLogs({
      config: { bucket: "logs", prefix: "tenant-static/" },
      now: () => scanStart,
      loadCursor: () => Promise.resolve(undefined),
      list: (input) => {
        prefixes.push(input.Prefix ?? "")
        return Promise.resolve({})
      },
      advanceCursor: (_db, cursor) => {
        advanced.push(cursor)
        return Promise.resolve()
      },
    })

    await handler({} as never, scanContext())

    expect(prefixes).toHaveLength(91)
    expect(prefixes[0]).toBe("tenant-static/2026/05/30/")
    expect(prefixes.at(-1)).toBe("tenant-static/2026/08/28/")
    expect(advanced).toEqual([scanStart])
  })

  it("recovers every prefix after a seven-day worker outage", async () => {
    const prefixes: string[] = []
    const advanced: Date[] = []
    const scanStart = new Date("2026-08-28T12:01:00.000Z")
    const handler = scanStaticCloudFrontLogs({
      config: { bucket: "logs", prefix: "tenant-static/" },
      now: () => scanStart,
      loadCursor: () => Promise.resolve(new Date("2026-08-21T12:01:00.000Z")),
      list: (input) => {
        prefixes.push(input.Prefix ?? "")
        return Promise.resolve({})
      },
      advanceCursor: (_db, cursor) => {
        advanced.push(cursor)
        return Promise.resolve()
      },
    })

    await handler({} as never, scanContext())

    expect(prefixes).toHaveLength(10)
    expect(prefixes[0]).toBe("tenant-static/2026/08/19/")
    expect(prefixes.at(-1)).toBe("tenant-static/2026/08/28/")
    expect(advanced).toEqual([scanStart])
  })

  it("rediscovers late objects inside the overlap with stable object keys", async () => {
    const queued: { key: string; etag: string; idempotencyKey: string }[] = []
    const handler = scanStaticCloudFrontLogs({
      config: { bucket: "logs", prefix: "tenant-static/" },
      now: () => new Date("2026-08-29T12:01:00.000Z"),
      loadCursor: () => Promise.resolve(new Date("2026-08-28T12:01:00.000Z")),
      list: (input) =>
        Promise.resolve(
          input.Prefix === "tenant-static/2026/08/27/"
            ? { Contents: [{ Key: `${input.Prefix}late.w3c.gz`, ETag: '"same-etag"' }] }
            : {},
        ),
      enqueueObject: (_db, input) => {
        queued.push(input)
        return Promise.resolve()
      },
      advanceCursor: () => Promise.resolve(),
    })

    await handler({} as never, scanContext())

    expect(queued).toEqual([
      {
        key: "tenant-static/2026/08/27/late.w3c.gz",
        etag: '"same-etag"',
        idempotencyKey: staticCloudFrontObjectIdempotencyKey({
          bucket: "logs",
          key: "tenant-static/2026/08/27/late.w3c.gz",
          etag: '"same-etag"',
        }),
      },
    ])
  })

  it("does not advance the cursor when any prefix fails", async () => {
    let calls = 0
    const advanced: Date[] = []
    const handler = scanStaticCloudFrontLogs({
      config: { bucket: "logs", prefix: "tenant-static/" },
      now: () => new Date("2026-08-28T12:01:00.000Z"),
      loadCursor: () => Promise.resolve(new Date("2026-08-27T12:01:00.000Z")),
      list: () => {
        calls++
        return calls === 2
          ? Promise.reject(new Error("S3 unavailable"))
          : Promise.resolve({ IsTruncated: true, NextContinuationToken: "next-page" })
      },
      advanceCursor: (_db, cursor) => {
        advanced.push(cursor)
        return Promise.resolve()
      },
    })

    await expect(handler({} as never, scanContext())).rejects.toThrow("S3 unavailable")
    expect(advanced).toEqual([])
  })

  it("rejects malformed rows instead of silently dropping billable usage", () => {
    expect(() =>
      parseStaticCloudFrontLog(
        "#Fields: timestamp(ms) x-edge-request-id x-host-header sc-bytes\nnope\treq\thost\tnot-a-number\n",
      ),
    ).toThrow(/invalid sc-bytes/)
  })

  it("records a comparable request-count gap without inventing a byte residual", async () => {
    const reconciliations: Record<string, unknown>[] = []
    const handler = reconcileStaticCloudFrontUsage({
      distributionId: "EDISTRIBUTION",
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      providerTotals: () => Promise.resolve({ requests: "10" }),
      importedTotals: () => Promise.resolve({ requests: "8.000000000" }),
      store: (_db, input) => {
        reconciliations.push(input)
        return Promise.resolve()
      },
    })

    await handler({} as never, scanContext())

    expect(reconciliations).toHaveLength(3)
    expect(reconciliations.map(({ periodStart, status }) => ({ periodStart, status }))).toEqual([
      { periodStart: new Date("2026-08-27T00:00:00.000Z"), status: "pending_delivery" },
      { periodStart: new Date("2026-08-26T00:00:00.000Z"), status: "pending_delivery" },
      { periodStart: new Date("2026-08-25T00:00:00.000Z"), status: "platform_overhead" },
    ])
    expect(reconciliations[0]).toMatchObject({
      providerRequests: "10",
      importedRequests: "8",
      residualRequests: "2",
      resourceId: "EDISTRIBUTION",
    })
    expect(reconciliations[0]).not.toHaveProperty("providerEgressBytes")
    expect(reconciliations[0]).not.toHaveProperty("importedEgressBytes")
    expect(reconciliations[0]).not.toHaveProperty("residualEgressBytes")
  })

  it("converges provider corrections absolutely and never invents a negative residual", async () => {
    const reconciliations: Record<string, unknown>[] = []
    const handler = reconcileStaticCloudFrontUsage({
      distributionId: "EDISTRIBUTION",
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      providerTotals: () => Promise.resolve({ requests: "9" }),
      importedTotals: () => Promise.resolve({ requests: "10.000000000" }),
      store: (_db, input) => {
        reconciliations.push(input)
        return Promise.resolve()
      },
    })

    await handler({} as never, scanContext())
    await handler({} as never, scanContext())

    expect(reconciliations).toHaveLength(6)
    expect(
      reconciliations.every((row) => row.status === "matched" && row.residualRequests === "0"),
    ).toBe(true)
    expect(reconciliations.slice(0, 3)).toEqual(reconciliations.slice(3))
  })
})

function scanContext() {
  return {
    db: {},
    keepAlive: () => Promise.resolve(true),
    signal: new AbortController().signal,
  } as never
}
