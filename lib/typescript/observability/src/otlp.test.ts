import { describe, expect, it } from "vitest"
import {
  anyValueToString,
  attributesToMap,
  MalformedOtlpError,
  nanosToClickhouse,
  parseLogsRequest,
} from "./otlp"

/*
  These are pure and run everywhere, deliberately.

  The parser is where a customer's telemetry is silently dropped or silently mangled, and neither
  failure produces an error anyone sees — the exporter gets a 200 and the logs simply are not there.
  So it is tested without needing ClickHouse.
*/

describe("nanosToClickhouse", () => {
  it("keeps nanosecond precision above 2^53", () => {
    // 2^53 nanoseconds ran out in 1970 plus a hundred days, so every real timestamp is past it.
    expect(nanosToClickhouse("1735689600123456789")).toBe("1735689600.123456789")

    // What it costs to go through `number`, shown rather than asserted about. Comparing to a
    // numeric literal proves nothing — the literal is a float too, and both sides round to the
    // same wrong value.
    expect(String(Number("1735689600123456789"))).not.toBe("1735689600123456789")
    expect(String(Number("1735689600123456789"))).toBe("1735689600123456800")
  })

  it("pads the fraction so the digits keep their place value", () => {
    // 7 nanoseconds past the second is `.000000007`, not `.7`.
    expect(nanosToClickhouse("1000000000000000007")).toBe("1000000000.000000007")
    expect(nanosToClickhouse("1000000000000000000")).toBe("1000000000.000000000")
  })

  it("accepts a number as well as a string", () => {
    expect(nanosToClickhouse(1_500_000_000_000_000)).toBe("1500000.000000000")
  })

  it("refuses what is not a timestamp", () => {
    for (const bad of [undefined, null, "", "not-a-number", 0, -1, {}]) {
      expect(nanosToClickhouse(bad)).toBeUndefined()
    }
  })
})

describe("anyValueToString", () => {
  it("unwraps every scalar the protobuf JSON mapping produces", () => {
    expect(anyValueToString({ stringValue: "hello" })).toBe("hello")
    expect(anyValueToString({ boolValue: false })).toBe("false")
    expect(anyValueToString({ intValue: "9007199254740993" })).toBe("9007199254740993")
    expect(anyValueToString({ doubleValue: 1.5 })).toBe("1.5")
  })

  it("keeps a 64-bit int exactly", () => {
    // As a string in the payload and a string on the way out: routing it through Number would land
    // on 9007199254740992.
    expect(anyValueToString({ intValue: "9007199254740993" })).toBe("9007199254740993")
  })

  it("accepts snake_case as well", () => {
    // The protobuf JSON mapping says a parser must accept both, and SDKs differ.
    expect(anyValueToString({ string_value: "hello" })).toBe("hello")
    expect(anyValueToString({ int_value: "42" })).toBe("42")
  })

  it("keeps a structured value as JSON rather than dropping it", () => {
    const nested = anyValueToString({ arrayValue: { values: [{ stringValue: "a" }] } })
    expect(nested).toContain("a")
    expect(nested).not.toBe("")
  })

  it("is empty for nothing at all", () => {
    expect(anyValueToString(undefined)).toBe("")
    expect(anyValueToString(null)).toBe("")
  })

  it("does not distinguish false from absent by returning empty", () => {
    // A regression guard: `boolValue: false` is falsy, and an early `if (!value)` would drop it.
    expect(anyValueToString({ boolValue: false })).toBe("false")
    expect(anyValueToString({ intValue: 0 })).toBe("0")
  })
})

describe("attributesToMap", () => {
  it("flattens a KeyValue list", () => {
    expect(
      attributesToMap([
        { key: "http.method", value: { stringValue: "GET" } },
        { key: "http.status", value: { intValue: "200" } },
      ]),
    ).toEqual({ "http.method": "GET", "http.status": "200" })
  })

  it("skips an entry with no usable key rather than inventing one", () => {
    expect(attributesToMap([{ value: { stringValue: "x" } }, { key: "", value: {} }])).toEqual({})
  })

  it("is empty for anything that is not a list", () => {
    expect(attributesToMap(undefined)).toEqual({})
    expect(attributesToMap(null)).toEqual({})
  })
})

describe("parseLogsRequest", () => {
  const request = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "checkout" } },
            { key: "deployment.environment", value: { stringValue: "production" } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "express" },
            logRecords: [
              {
                timeUnixNano: "1735689600123456789",
                observedTimeUnixNano: "1735689600123456999",
                severityNumber: 17,
                severityText: "ERROR",
                body: { stringValue: "payment failed" },
                traceId: "5b8efff798038103d269b633813fc60c",
                spanId: "eee19b7ec3c1b174",
                attributes: [{ key: "order.id", value: { stringValue: "o-1" } }],
              },
            ],
          },
        ],
      },
    ],
  }

  it("reads one record with everything in place", () => {
    const [row] = parseLogsRequest(request)
    expect(row).toBeDefined()
    expect(row?.timestamp).toBe("1735689600.123456789")
    expect(row?.severityText).toBe("ERROR")
    expect(row?.body).toBe("payment failed")
    expect(row?.serviceName).toBe("checkout")
    expect(row?.scopeName).toBe("express")
    expect(row?.traceId).toBe("5b8efff798038103d269b633813fc60c")
    expect(row?.attributes).toEqual({ "order.id": "o-1" })
  })

  it("merges resource attributes into every record", () => {
    // Denormalized on purpose: logs are read by time range and dropped by TTL, so a join to a
    // resource table would make every query pay for normalization nothing ever updates.
    const [row] = parseLogsRequest(request)
    expect(row?.resourceAttributes["deployment.environment"]).toBe("production")
  })

  it("falls back to the observed time when the event time is missing", () => {
    // `timeUnixNano` is optional in the spec — the SDK may not know when the event happened.
    // Storing 1970 instead would put the record outside every query's time range.
    const [row] = parseLogsRequest({
      resourceLogs: [
        {
          scopeLogs: [{ logRecords: [{ observedTimeUnixNano: "1735689600000000000", body: {} }] }],
        },
      ],
    })
    expect(row?.timestamp).toBe("1735689600.000000000")
    expect(row?.observedTimestamp).toBe("1735689600.000000000")
  })

  it("stamps a record with no timestamps at all with now", () => {
    const before = Date.now() / 1000
    const [row] = parseLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }] }],
    })
    expect(Number(row?.timestamp)).toBeGreaterThanOrEqual(Math.floor(before))
  })

  it("derives severity text from the number when the text is absent", () => {
    // OTel severity numbers come in bands of four: 17-20 are all ERROR.
    for (const [number, text] of [
      [1, "TRACE"],
      [5, "DEBUG"],
      [9, "INFO"],
      [12, "INFO"],
      [13, "WARN"],
      [18, "ERROR"],
      [21, "FATAL"],
    ] as const) {
      const [row] = parseLogsRequest({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: number, body: {} }] }] }],
      })
      expect(row?.severityText).toBe(text)
    }
  })

  it("accepts the snake_case spelling throughout", () => {
    const [row] = parseLogsRequest({
      resource_logs: [
        {
          resource: { attributes: [{ key: "service.name", value: { string_value: "api" } }] },
          scope_logs: [
            {
              log_records: [
                {
                  time_unix_nano: "1735689600000000000",
                  severity_number: 9,
                  body: { string_value: "hello" },
                  trace_id: "abc",
                },
              ],
            },
          ],
        },
      ],
    })
    expect(row?.body).toBe("hello")
    expect(row?.serviceName).toBe("api")
    expect(row?.traceId).toBe("abc")
    expect(row?.timestamp).toBe("1735689600.000000000")
  })

  it("returns nothing for an empty request rather than failing", () => {
    // An exporter with nothing to send still sends. A 400 here would look like an outage.
    expect(parseLogsRequest({})).toEqual([])
    expect(parseLogsRequest({ resourceLogs: [] })).toEqual([])
    expect(parseLogsRequest({ resourceLogs: [{ scopeLogs: [] }] })).toEqual([])
  })

  it("refuses a body that is not an object", () => {
    for (const bad of [null, "string", 42]) {
      expect(() => parseLogsRequest(bad)).toThrow(MalformedOtlpError)
    }
  })

  it("flattens every record across every resource and scope", () => {
    const rows = parseLogsRequest({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "a" } }] },
          scopeLogs: [
            { logRecords: [{ body: { stringValue: "1" } }, { body: { stringValue: "2" } }] },
            { logRecords: [{ body: { stringValue: "3" } }] },
          ],
        },
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "b" } }] },
          scopeLogs: [{ logRecords: [{ body: { stringValue: "4" } }] }],
        },
      ],
    })
    expect(rows.map((row) => row.body)).toEqual(["1", "2", "3", "4"])
    expect(rows.map((row) => row.serviceName)).toEqual(["a", "a", "a", "b"])
  })
})
