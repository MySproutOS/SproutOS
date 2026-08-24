import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import type { RuntimeLog } from "./runtime-logs"
import { decode, ship, type SubscriptionEvent } from "./shipper"

/**
 * The decoding is the part that bites: CloudWatch sends base64 of a gzip of the JSON, and a handler
 * that reaches for `JSON.parse` gets a syntax error saying nothing about compression.
 */
const PROJECT = "01a03600-0000-7000-8000-00000000d1ce"

function delivery(overrides: Partial<Record<string, unknown>> = {}): SubscriptionEvent {
  const payload = {
    messageType: "DATA_MESSAGE",
    logGroup: `/aws/lambda/sproutos-app-${PROJECT}`,
    logStream: "2026/08/24/[$LATEST]abc",
    logEvents: [
      { id: "1", timestamp: 1_800_000_000_000, message: "INFO serving a request" },
      { id: "2", timestamp: 1_800_000_000_001, message: "ERROR the upstream refused" },
    ],
    ...overrides,
  }
  return { awslogs: { data: gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64") } }
}

const live = () => Promise.resolve("01a03600-0000-7000-8000-0000000000de")

describe("the log shipper", () => {
  it("peels base64, gzip and JSON in that order", () => {
    const payload = decode(delivery())

    expect(payload.logGroup).toBe(`/aws/lambda/sproutos-app-${PROJECT}`)
    expect(payload.logEvents).toHaveLength(2)
  })

  it("writes the batch under the project's live deployment", async () => {
    const written: RuntimeLog[] = []
    const result = await ship(delivery(), live, (rows) => {
      written.push(...rows)
      return Promise.resolve()
    })

    expect(result.written).toBe(2)
    expect(written.every((row) => row.projectId === PROJECT)).toBe(true)
    expect(written[0]?.deploymentId).toBe("01a03600-0000-7000-8000-0000000000de")
    expect(written[1]?.level).toBe("error")
  })

  it("keeps the lines when the live deployment is unknown", async () => {
    /*
      The cache entry expires, and the moment a customer is most likely to be reading their logs is
      when something has just gone wrong. Dropping the batch to preserve a foreign key would lose
      exactly the output they came for.
    */
    const written: RuntimeLog[] = []
    const result = await ship(
      delivery(),
      () => Promise.resolve(undefined),
      (rows) => {
        written.push(...rows)
        return Promise.resolve()
      },
    )

    expect(result.written).toBe(2)
    expect(written[0]?.deploymentId).toBe("00000000-0000-0000-0000-000000000000")
  })

  it("says nothing about a control message", async () => {
    // CloudWatch sends this once when the filter is created, to check the destination answers. A
    // handler that treated it as data would write a row saying "CWL CONTROL MESSAGE".
    const written: RuntimeLog[] = []
    const result = await ship(
      delivery({ messageType: "CONTROL_MESSAGE", logEvents: [] }),
      live,
      (rows) => {
        written.push(...rows)
        return Promise.resolve()
      },
    )

    expect(result.written).toBe(0)
    expect(written).toHaveLength(0)
  })

  it("skips a log group that is not a tenant application, without retrying forever", async () => {
    const written: RuntimeLog[] = []
    const result = await ship(
      delivery({ logGroup: "/aws/lambda/sproutos-log-shipper" }),
      live,
      (rows) => {
        written.push(...rows)
        return Promise.resolve()
      },
    )

    // Skipped, not thrown. The filter is on a prefix, so a group matching it without matching the
    // naming is a configuration problem — throwing would have CloudWatch redeliver it forever.
    expect(result.written).toBe(0)
    expect(result.skipped).toBe(2)
    expect(written).toHaveLength(0)
  })

  it("fails loudly on a payload that will not decode", async () => {
    // Not "a batch with no lines in it". Returning success would have the Lambda succeed and
    // CloudWatch never redeliver, which loses the batch silently.
    await expect(ship({ awslogs: { data: "not base64 gzip" } }, live)).rejects.toThrow(
      /incorrect header check|Unexpected|invalid/i,
    )
  })
})
