import { describe, expect, it } from "vitest"
import { quantitiesFor, type WorkflowUsage } from "./rating"

function usage(overrides: Partial<WorkflowUsage> = {}): WorkflowUsage {
  return {
    jobsEnqueued: 0,
    bytesEnqueued: 0n,
    dwellMs: 0n,
    vcpuSeconds: 0,
    gibSeconds: 0,
    ...overrides,
  }
}

/**
 * TASK 25 bills on four things, and the byte-second one is where the arithmetic can quietly go
 * wrong: it is a product of two large numbers and it is the dimension whose rate is sub-micro.
 */
describe("quantitiesFor", () => {
  it("turns bytes and milliseconds into byte-seconds", () => {
    // 1 MB held for 10 seconds.
    expect(
      quantitiesFor(usage({ bytesEnqueued: 1_048_576n, dwellMs: 10_000n }))
        .valkey_queue_byte_second,
    ).toBe("10485760")
  })

  it("stays exact for a payload that sat in the queue all day", () => {
    // 1 MB for 24 hours is 9.06e10 byte-seconds — past the point where a float is a promise
    // rather than a number, which is why this is bigint all the way to the bill.
    const quantity = quantitiesFor(
      usage({ bytesEnqueued: 1_048_576n, dwellMs: 86_400_000n }),
    ).valkey_queue_byte_second
    expect(quantity).toBe("90596966400")
    expect(BigInt(quantity ?? "unmeasured")).toBe((1_048_576n * 86_400_000n) / 1000n)
  })

  it("charges nothing for a job that never waited", () => {
    expect(quantitiesFor(usage({ bytesEnqueued: 4_096n })).valkey_queue_byte_second).toBe("0")
    expect(quantitiesFor(usage({ dwellMs: 60_000n })).valkey_queue_byte_second).toBe("0")
  })

  it("keeps unmeasured queue residency unknown rather than calling it zero", () => {
    expect(
      quantitiesFor(usage({ bytesEnqueued: null, dwellMs: null })).valkey_queue_byte_second,
    ).toBeNull()
    expect(
      quantitiesFor(usage({ bytesEnqueued: 4096n, dwellMs: null })).valkey_queue_byte_second,
    ).toBeNull()
  })

  it("never produces a negative quantity", () => {
    // A clock stepping backwards mid-run would otherwise produce a credit nobody authorised.
    expect(
      quantitiesFor(usage({ bytesEnqueued: 100n, dwellMs: -5_000n })).valkey_queue_byte_second,
    ).toBe("0")
    expect(quantitiesFor(usage({ jobsEnqueued: -3 })).workflow_job_enqueued).toBe("0")
  })

  it("keeps sub-second execution rather than rounding it away", () => {
    // A workflow node that runs for 40ms is the common case, and a quantity of "0" would make
    // every fast workflow free.
    const quantities = quantitiesFor(usage({ vcpuSeconds: 0.04, gibSeconds: 0.0125 }))
    expect(quantities.workflow_exec_vcpu_second).toBe("0.040000000")
    expect(quantities.workflow_exec_gib_second).toBe("0.012500000")
  })

  it("counts jobs as whole jobs", () => {
    expect(quantitiesFor(usage({ jobsEnqueued: 17 })).workflow_job_enqueued).toBe("17")
  })
})
