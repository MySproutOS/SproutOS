import { describe, expect, it } from "vitest"
import {
  ceilDiv,
  creditedAmount,
  formatBalanceMicroUsd,
  formatMicroUsd,
  itemOverhead,
  MICRO_PER_USD,
  MINIMUM_TOPUP,
  overhead,
  processingFee,
  rateTimesQuantity,
} from "./money"

describe("processing fee", () => {
  it("covers Stripe's cut on the $1 minimum", () => {
    // 2.9% of $1.00 is $0.029, plus $0.30 fixed.
    const fee = processingFee(MINIMUM_TOPUP)
    expect(fee).toBe(329_000n)
    // The whole point: a $1 top-up that credited $1 would lose $0.329
    // every time. Here the platform nets zero rather than negative.
    expect(fee).toBeLessThan(MINIMUM_TOPUP)
    expect(creditedAmount(MINIMUM_TOPUP)).toBe(671_000n)
  })

  it("gets proportionally cheaper as the top-up grows", () => {
    const ratio = (amount: bigint) => Number(processingFee(amount)) / Number(amount)
    expect(ratio(500_000n)).toBeCloseTo(0.629, 3)
    expect(ratio(10n * MICRO_PER_USD)).toBeCloseTo(0.059, 3)
    expect(ratio(100n * MICRO_PER_USD)).toBeCloseTo(0.032, 3)
  })

  it("never credits a negative amount", () => {
    expect(creditedAmount(1n)).toBe(0n)
    expect(creditedAmount(0n)).toBe(0n)
  })

  it("rounds the fee up, so the remainder is never eaten", () => {
    // 2.9% of 1 micro-USD is 0.000029 — must not floor to zero.
    expect(processingFee(1n)).toBe(300_001n)
  })
})

describe("overhead", () => {
  it("applies the price book's basis points", () => {
    expect(overhead(1_000_000n, 1200)).toBe(120_000n)
  })

  it("rounds up rather than losing the remainder on every event", () => {
    expect(overhead(1n, 1200)).toBe(1n)
    expect(overhead(0n, 1200)).toBe(0n)
  })

  it("uses a dimension override, including an explicit zero, or inherits the book default", () => {
    expect(itemOverhead(1_000_000n, 200, 1200)).toBe(20_000n)
    expect(itemOverhead(1_000_000n, 0, 1200)).toBe(0n)
    expect(itemOverhead(1_000_000n, null, 1200)).toBe(120_000n)
  })
})

describe("ceilDiv", () => {
  it("rounds away from zero in both directions", () => {
    expect(ceilDiv(7n, 2n)).toBe(4n)
    expect(ceilDiv(-7n, 2n)).toBe(-4n)
    expect(ceilDiv(6n, 2n)).toBe(3n)
  })

  it("refuses to divide by zero", () => {
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError)
  })
})

describe("rateTimesQuantity", () => {
  it("bills the sub-micro rates that a bigint rate would have floored to zero", () => {
    // These three are exactly why price_book_item.unit_micro_usd is numeric(38,9).
    // As integer micro-USD each would be 0, and the dimension would bill nothing.
    expect(rateTimesQuantity("0.000140000", "1000000")).toBe(140n)
    expect(rateTimesQuantity("0.000001000", "5000000")).toBe(5n)
    expect(rateTimesQuantity("0.330000000", "18402")).toBe(6073n)
  })

  it("rounds a partial micro up rather than to nothing", () => {
    expect(rateTimesQuantity("0.000140000", "1")).toBe(1n)
  })

  it("handles whole rates exactly", () => {
    expect(rateTimesQuantity("3.000000000", "3600")).toBe(10_800n)
  })

  it("rejects a value that is not a decimal", () => {
    expect(() => rateTimesQuantity("1e-4", "10")).toThrow(RangeError)
  })
})

describe("formatMicroUsd", () => {
  it("shows cents by default and sub-cent precision when present", () => {
    expect(formatMicroUsd(1_204_000_000n)).toBe("$1,204.00")
    expect(formatMicroUsd(41_200n)).toBe("$0.0412")
    expect(formatMicroUsd(0n)).toBe("$0.00")
    expect(formatMicroUsd(-500_000n)).toBe("-$0.50")
  })

  it("does not lose precision on a value no float could hold", () => {
    expect(formatMicroUsd(9_007_199_254_740_993_000n)).toBe("$9,007,199,254,740.993")
  })
})

describe("formatBalanceMicroUsd", () => {
  it("shows dollars and cents", () => {
    expect(formatBalanceMicroUsd(11_292_288n)).toBe("$11.29")
    expect(formatBalanceMicroUsd(1_000_000n)).toBe("$1.00")
    expect(formatBalanceMicroUsd(0n)).toBe("$0.00")
  })

  it("rounds down, never to nearest", () => {
    /*
      `$11.30` for a balance of 11.299999 tells a customer they can spend a cent they do not have,
      and the failure lands at the moment they try to.
    */
    expect(formatBalanceMicroUsd(11_299_999n)).toBe("$11.29")
    expect(formatBalanceMicroUsd(9_999n)).toBe("$0.00")
  })

  it("groups thousands", () => {
    expect(formatBalanceMicroUsd(1_204_560_000n)).toBe("$1,204.56")
  })

  it("handles a negative balance", () => {
    // Overdraft should not happen — `spend()` locks and checks — but a display that renders it as a
    // large positive number would hide the one case worth noticing.
    expect(formatBalanceMicroUsd(-2_500_000n)).toBe("-$2.50")
  })
})
