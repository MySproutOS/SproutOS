import { describe, expect, it } from "vitest"
import { EGRESS_ALLOWED_DOMAINS, EGRESS_DOMAIN_ALLOW_LIST } from "./egress"

describe("Daytona egress policy", () => {
  it("fits the provider's twenty-domain limit", () => {
    expect(EGRESS_ALLOWED_DOMAINS.length).toBeLessThanOrEqual(20)
    expect(EGRESS_DOMAIN_ALLOW_LIST.split(",")).toEqual(EGRESS_ALLOWED_DOMAINS)
  })

  it("contains the services a sandbox needs to bootstrap and run", () => {
    expect(EGRESS_ALLOWED_DOMAINS).toEqual(
      expect.arrayContaining([
        "*.sproutos.me",
        "*.github.com",
        "*.githubusercontent.com",
        "registry.npmjs.org",
        "*.neon.tech",
      ]),
    )
  })

  it("does not admit raw IP ranges or a universal wildcard", () => {
    for (const domain of EGRESS_ALLOWED_DOMAINS) {
      expect(domain).not.toBe("*")
      expect(domain).not.toContain("/")
      expect(domain).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    }
  })
})
