import { describe, expect, it } from "vitest"
import { accumulateTokenUsage, runUsageEvents } from "./run"

const input = {
  organizationId: "01990a1d-a9ea-7000-8000-000000000001",
  projectId: "01990a1d-a9ea-7000-8000-000000000002",
  resourceType: "agent_run",
  resourceId: "01990a1d-a9ea-7000-8000-000000000003",
}

describe("runUsageEvents", () => {
  it("emits token and runtime dimensions with their actual charging boundaries", () => {
    const startedAt = new Date("2026-08-26T12:00:00.000Z")
    const occurredAt = new Date("2026-08-26T12:00:01.250Z")
    const events = runUsageEvents(
      input,
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7 },
      "01990a1d-a9ea-7000-8000-000000000004",
      startedAt,
      occurredAt,
      true,
    )

    expect(
      events.map(({ dimension, quantity, chargedExternally }) => ({
        dimension,
        quantity,
        chargedExternally,
      })),
    ).toEqual([
      { dimension: "ai_input_token", quantity: "10", chargedExternally: true },
      { dimension: "ai_output_token", quantity: "2", chargedExternally: true },
      { dimension: "ai_cache_read_token", quantity: "7", chargedExternally: true },
      { dimension: "agent_run_second", quantity: "1.25", chargedExternally: false },
    ])
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length)
    expect(events.every((event) => event.windowStart?.getTime() === startedAt.getTime())).toBe(true)
    expect(events.every((event) => event.windowEnd?.getTime() === occurredAt.getTime())).toBe(true)
  })

  it("omits zero-quantity dimensions", () => {
    const at = new Date("2026-08-26T12:00:00.000Z")
    expect(
      runUsageEvents(
        input,
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        "01990a1d-a9ea-7000-8000-000000000004",
        at,
        at,
        true,
      ),
    ).toEqual([])
  })
})

describe("accumulateTokenUsage", () => {
  it("retains long-context cache writes across provider reports", () => {
    const usage = { inputTokens: 0, outputTokens: 0 }
    accumulateTokenUsage(usage, {
      inputTokens: 1,
      outputTokens: 2,
      longContextCacheWriteTokens: 3,
    })
    accumulateTokenUsage(usage, {
      inputTokens: 4,
      outputTokens: 5,
      longContextCacheWriteTokens: 6,
    })

    expect(usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      longContextCacheWriteTokens: 9,
    })
  })
})
