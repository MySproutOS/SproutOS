import { describe, expect, it } from "vitest"
import { gbSeconds, usageFrom, usageFromBatch } from "./lambda-usage"
import { toRows } from "./runtime-logs"

/**
 * What the customer is charged for one invocation. The numbers here are AWS's own published
 * example figures, so a mistake shows up as a disagreement with the invoice rather than with us.
 */
const PROJECT = "01a03600-0000-7000-8000-00000000d1ce"
const DEPLOYMENT = "01a03600-0000-7000-8000-0000000000de"

function report(line: string) {
  const [row] = toRows(`/aws/lambda/sproutos-app-${PROJECT}`, DEPLOYMENT, [
    { timestamp: 1_800_000_000_000, message: line },
  ])
  return row
}

describe("charging for an invocation", () => {
  it("computes GB-seconds the way Lambda defines them", () => {
    // 512 MB for 1000 ms is half a GB-second. AWS's GB is 1024 MB, not 1000.
    expect(gbSeconds(512, 1000)).toBeCloseTo(0.5, 9)
    expect(gbSeconds(1024, 1000)).toBeCloseTo(1, 9)
    // 128 MB for 2 ms: 128/1024 × 2/1000 = 0.00025. The shape that floors to zero if quantities
    // are kept as integers.
    expect(gbSeconds(128, 2)).toBeCloseTo(0.00025, 9)
  })

  it("bills the rounded duration, not the measured one", () => {
    /*
      `Duration` and `Billed Duration` differ, and on a cold start the billed figure includes the
      init that the measured one excludes. Metering `Duration` would absorb every cold start's
      initialisation as platform cost — invisible in testing, and exactly proportional to how many
      new customers arrive.
    */
    const cold = report(
      "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 1.23 ms\t" +
        "Billed Duration: 220 ms\tMemory Size: 512 MB\tMax Memory Used: 78 MB\t" +
        "Init Duration: 210.50 ms",
    )

    const [compute] = usageFrom(cold)
    expect(compute?.dimension).toBe("site_gib_second")
    // 512/1024 × 220/1000 = 0.11, from Billed Duration. From Duration it would be 0.000615.
    expect(Number(compute?.quantity)).toBeCloseTo(0.11, 9)
  })

  it("charges one request per invocation, not per log line", () => {
    const events = usageFrom(
      report(
        "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 5 ms\t" +
          "Billed Duration: 5 ms\tMemory Size: 128 MB\tMax Memory Used: 40 MB",
      ),
    )

    expect(events.filter((event) => event.dimension === "site_request")).toHaveLength(1)
    expect(events).toHaveLength(2)
  })

  it("charges nothing for a line that is not a report", () => {
    // A customer's own output is not an invocation. Charging per line would bill a chatty
    // application many times for one request.
    expect(usageFrom(report("INFO handling a request"))).toHaveLength(0)
    expect(usageFrom(report("START RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd"))).toHaveLength(
      0,
    )
  })

  it("keeps a short invocation's quantity above zero", () => {
    const events = usageFrom(
      report(
        "REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abcd\tDuration: 0.5 ms\t" +
          "Billed Duration: 1 ms\tMemory Size: 128 MB\tMax Memory Used: 20 MB",
      ),
    )

    // A platform that rounds short requests to zero is one whose cheapest customers cost it the
    // most. Nine decimal places is the price book's own numeric(38, 9).
    expect(Number(events[0]?.quantity)).toBeGreaterThan(0)
  })

  it("adds up a batch the way a bill does", () => {
    const lines = [1, 2, 3].map((n) =>
      report(
        `REPORT RequestId: 8a2f4b1c-0000-4000-8000-00000000abc${n}\tDuration: 10 ms\t` +
          "Billed Duration: 100 ms\tMemory Size: 1024 MB\tMax Memory Used: 100 MB",
      ),
    )

    const events = usageFromBatch(lines)
    const compute = events
      .filter((event) => event.dimension === "site_gib_second")
      .reduce((total, event) => total + Number(event.quantity), 0)

    // Three invocations of 1 GB for 100 ms is 0.3 GB-seconds.
    expect(compute).toBeCloseTo(0.3, 9)
    expect(events.filter((event) => event.dimension === "site_request")).toHaveLength(3)
  })
})
