import { describe, expect, it } from "vitest"
import { creditRunway } from "./billing"

/**
 * The line under the balance in the sidebar.
 *
 * It read `~-24 days at current burn` on a live account that had spent past zero: the balance was
 * negative and nothing checked before dividing it by the burn rate. The comment above the original
 * reasoned carefully about a burn rate of zero — "with no burn there is nothing to run out of" —
 * and never considered a balance below it, which is the case an actual customer reaches.
 */
describe("creditRunway", () => {
  const perDay = 1_000_000n

  it("says an overdrawn account is out, not that it has negative days", () => {
    expect(creditRunway(-24_000_000n, perDay)).toEqual({
      percentRemaining: 0,
      label: "Out of credit — top up to keep running",
    })
  })

  it("treats exactly zero as out, because it is", () => {
    expect(creditRunway(0n, perDay).percentRemaining).toBe(0)
    expect(creditRunway(0n, perDay).label).toContain("Out of credit")
  })

  it("says so plainly when nothing is being spent, rather than claiming infinity days", () => {
    expect(creditRunway(10_000_000n, 0n)).toEqual({
      percentRemaining: 100,
      label: "No usage recorded yet",
    })
  })

  it("counts whole days, and gets the singular right", () => {
    expect(creditRunway(3_000_000n, perDay).label).toBe("~3 days at current burn")
    expect(creditRunway(1_900_000n, perDay).label).toBe("~1 day at current burn")
  })

  it("fills the meter at a month of runway and caps there", () => {
    // Full means "a month", which is a thing a person can act on. A year of credit is not 1200%.
    expect(creditRunway(30n * perDay, perDay).percentRemaining).toBe(100)
    expect(creditRunway(365n * perDay, perDay).percentRemaining).toBe(100)
    expect(creditRunway(15n * perDay, perDay).percentRemaining).toBe(50)
  })
})
