import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { activeTokenRates, rateTokens } from "./pricing"

let reachable = false

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    // The repository's database-backed tests skip when compose is not running.
  }
})

afterAll(async () => {
  await db.destroy()
})

describe("platform AI pass-through pricing", () => {
  it("uses the provider token rates and adds no platform overhead", async ({ skip }) => {
    if (!reachable) skip()

    const active = await activeTokenRates(db)
    expect(active.rates).toMatchObject({
      ai_input_token: { rate: "2.000000000", overheadBps: 0 },
      ai_output_token: { rate: "12.000000000", overheadBps: 0 },
      ai_cache_read_token: { rate: "0.200000000", overheadBps: 0 },
      ai_cache_write_token: { rate: "2.500000000", overheadBps: 0 },
      ai_long_context_input_token: { rate: "4.000000000", overheadBps: 0 },
      ai_long_context_output_token: { rate: "18.000000000", overheadBps: 0 },
      ai_long_context_cache_read_token: { rate: "0.400000000", overheadBps: 0 },
      ai_long_context_cache_write_token: { rate: "5.000000000", overheadBps: 0 },
    })

    const rated = await rateTokens(db, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    })
    expect(rated.usage).toBe(14_200_000n)
    expect(rated.overhead).toBe(0n)
    expect(rated.total).toBe(rated.usage)
  })

  it("rates cache writes and long-context requests in their provider buckets", async ({ skip }) => {
    if (!reachable) skip()

    const rated = await rateTokens(db, {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
      longContextInputTokens: 1_000_000,
      longContextOutputTokens: 1_000_000,
      longContextCacheReadTokens: 1_000_000,
      longContextCacheWriteTokens: 1_000_000,
    })
    expect(rated.usage).toBe(29_900_000n)
    expect(rated.overhead).toBe(0n)
  })
})
