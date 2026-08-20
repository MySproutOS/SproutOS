import { describe, expect, it } from "vitest"
import { decideUpkeepAction, upkeepBranchName, type UpstreamComparison } from "./upkeep-decision"

function comparison(overrides: Partial<UpstreamComparison> = {}): UpstreamComparison {
  return {
    behindBy: 0,
    aheadBy: 0,
    status: "identical",
    upstreamSha: "a".repeat(40),
    forkSha: "b".repeat(40),
    changedFiles: 0,
    ...overrides,
  }
}

describe("decideUpkeepAction", () => {
  it("does nothing when upstream has nothing new", () => {
    // Runs nightly. Waking an agent to discover there is nothing to do would bill the customer
    // for a no-op, every night, forever.
    expect(decideUpkeepAction(comparison()).action).toBe("skip")
    expect(decideUpkeepAction(comparison({ aheadBy: 12, status: "ahead" })).action).toBe("skip")
  })

  it("fast-forwards a fork with no local commits", () => {
    // The common case: someone forked an app and changed configuration, not code. The merge is
    // mechanical, so paying a model to perform it would be absurd.
    const decision = decideUpkeepAction(comparison({ behindBy: 7, status: "behind" }))
    expect(decision.action).toBe("fast_forward")
    if (decision.action !== "fast_forward") throw new Error("unreachable")
    expect(decision.mergeType).toBe("fast_forward")
  })

  it("only reconciles when both sides have moved", () => {
    // The one path that spends tokens.
    const decision = decideUpkeepAction(comparison({ behindBy: 3, aheadBy: 4, status: "diverged" }))
    expect(decision.action).toBe("reconcile")
    if (decision.action !== "reconcile") throw new Error("unreachable")
    expect(decision.reason).toContain("3 commit(s) behind")
  })

  it("treats being behind as the only thing that triggers work", () => {
    // GitHub's `status` string is not consulted: a comparison can say "diverged" while behindBy
    // is 0 depending on the base. behindBy is the fact that matters, so the decision reads it
    // rather than the label.
    expect(decideUpkeepAction(comparison({ status: "diverged", aheadBy: 5 })).action).toBe("skip")
  })
})

describe("upkeepBranchName", () => {
  it("names the branch after the commit it brings in", () => {
    const name = upkeepBranchName("0123456789abcdef0123456789abcdef01234567")
    expect(name).toBe("sproutos/upkeep-0123456789ab")
  })

  it("is stable, so a re-run reuses the branch", () => {
    // A retried job must not open a second pull request for the same upstream change.
    const sha = "f".repeat(40)
    expect(upkeepBranchName(sha)).toBe(upkeepBranchName(sha))
  })
})
