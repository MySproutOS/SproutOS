import { describe, expect, it } from "vitest"
import { cronTriggerConfig, nextCronAt } from "./cron"

describe("workflow cron", () => {
  it("calculates in the configured timezone across DST", () => {
    expect(
      nextCronAt("0 9 * * *", "America/New_York", new Date("2026-03-08T12:00:00Z")).toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z")
  })

  it("rejects a cron trigger with no schedule", () => {
    expect(() => cronTriggerConfig({ nodes: [{ type: "trigger.cron", config: {} }] })).toThrow(
      "cronExpression",
    )
  })
})
