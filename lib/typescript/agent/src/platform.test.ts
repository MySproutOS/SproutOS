import { describe, expect, it } from "vitest"
import { type OpenAiUsage, toTokenUsage } from "./platform"

function usage(overrides: Partial<OpenAiUsage> = {}): OpenAiUsage {
  return { prompt_tokens: 0, completion_tokens: 0, ...overrides }
}

/**
 * These three numbers are what the customer is charged. The two mistakes available here move the
 * bill in opposite directions and neither one fails visibly.
 */
describe("toTokenUsage", () => {
  it("maps a plain response", () => {
    // The real shape from a live call.
    expect(toTokenUsage(usage({ prompt_tokens: 94, completion_tokens: 139 }))).toEqual({
      inputTokens: 94,
      outputTokens: 139,
      cacheReadTokens: 0,
    })
  })

  it("takes cached tokens out of the input count rather than counting them twice", () => {
    // prompt_tokens is the total *including* cached. Leaving them in charges the full input rate
    // for text the model did not reprocess — which is most of a long conversation.
    expect(
      toTokenUsage(
        usage({
          prompt_tokens: 10_000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 9_000 },
        }),
      ),
    ).toEqual({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 9_000 })
  })

  it("does not add reasoning tokens on top of the completion count", () => {
    // Observed live: completion_tokens 139 = 128 reasoning + 11 visible. Adding
    // reasoning_tokens would double-bill the most expensive dimension.
    expect(
      toTokenUsage(
        usage({
          prompt_tokens: 14,
          completion_tokens: 139,
          completion_tokens_details: { reasoning_tokens: 128 },
        }),
      ).outputTokens,
    ).toBe(139)
  })

  it("never reports a negative input count", () => {
    // Defensive: a provider reporting more cached than prompt tokens would otherwise produce a
    // negative quantity, and durable usage quantity is a decimal a statement sums.
    expect(
      toTokenUsage(
        usage({
          prompt_tokens: 5,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 9 },
        }),
      ).inputTokens,
    ).toBe(0)
  })
})
