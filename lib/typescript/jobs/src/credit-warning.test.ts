import { describe, expect, it } from "vitest"
import { retentionWarningStage } from "./credit-state"

describe("retentionWarningStage", () => {
  const now = new Date("2026-09-01T12:00:00Z")

  it("warns at seven days, becomes critical at two, and suspends at the reserve", () => {
    expect(
      retentionWarningStage({
        balance: 7_100n,
        reserve: 100n,
        burnPerDay: 1_000n,
        deleteAfter: null,
        status: "active",
        now,
      }),
    ).toBe("warning")
    expect(
      retentionWarningStage({
        balance: 2_100n,
        reserve: 100n,
        burnPerDay: 1_000n,
        deleteAfter: null,
        status: "active",
        now,
      }),
    ).toBe("critical")
    expect(
      retentionWarningStage({
        balance: 100n,
        reserve: 100n,
        burnPerDay: 1_000n,
        deleteAfter: new Date("2026-09-03T12:00:00Z"),
        status: "suspended",
        now,
      }),
    ).toBe("suspended")
  })

  it("uses the final 24-hour warning without moving the durable deadline", () => {
    expect(
      retentionWarningStage({
        balance: 0n,
        reserve: 100n,
        burnPerDay: 1_000n,
        deleteAfter: new Date("2026-09-02T11:59:59Z"),
        status: "suspended",
        now,
      }),
    ).toBe("deletion_imminent")
  })
})
