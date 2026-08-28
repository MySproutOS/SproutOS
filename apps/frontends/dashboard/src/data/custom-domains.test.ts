import { describe, expect, it } from "vitest"
import {
  CUSTOM_DOMAIN_POLL_INTERVAL_MS,
  customDomainNeedsPolling,
  shouldPollCustomDomains,
} from "./custom-domains"

describe("custom-domain polling", () => {
  it.each(["pending_dns", "issuing", "propagating", "renewal_warning", "deleting"] as const)(
    "keeps %s fresh while reconciliation is unfinished",
    (status) => {
      expect(customDomainNeedsPolling(status)).toBe(true)
    },
  )

  it.each(["active", "failed"] as const)("does not poll terminal status %s", (status) => {
    expect(customDomainNeedsPolling(status)).toBe(false)
  })

  it("polls every minute only for a visible list containing unfinished work", () => {
    const unfinished = [{ status: "active" as const }, { status: "issuing" as const }]

    expect(shouldPollCustomDomains(unfinished, "visible")).toBe(true)
    expect(shouldPollCustomDomains(unfinished, "hidden")).toBe(false)
    expect(shouldPollCustomDomains([{ status: "active" }], "visible")).toBe(false)
    expect(shouldPollCustomDomains(undefined, "visible")).toBe(false)
    expect(CUSTOM_DOMAIN_POLL_INTERVAL_MS).toBe(60_000)
  })
})
