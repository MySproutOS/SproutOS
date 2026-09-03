import { describe, expect, it } from "vitest"
import {
  classifyManagedHostname,
  looksLikeApex,
  normalizeCustomDomainHostname,
  supportsCustomDomains,
  verificationName,
} from "./custom-domains"

describe("looksLikeApex", () => {
  it("uses the Public Suffix List for ordinary and multi-label suffixes", () => {
    expect(looksLikeApex("example.com")).toBe(true)
    expect(looksLikeApex("www.example.com")).toBe(false)
    expect(looksLikeApex("example.co.uk")).toBe(true)
    expect(looksLikeApex("www.example.co.uk")).toBe(false)
  })

  it("treats private suffixes as registrable boundaries", () => {
    expect(looksLikeApex("tenant.github.io")).toBe(true)
    expect(looksLikeApex("www.tenant.github.io")).toBe(false)
  })
})

describe("custom-domain serving mode", () => {
  it("keeps static CloudFront projects isolated from the dynamic-domain path", () => {
    expect(supportsCustomDomains("serverless")).toBe(true)
    expect(supportsCustomDomains("static")).toBe(false)
  })
})

describe("verificationName", () => {
  it("uses an isolated ownership label", () => {
    expect(verificationName("example.com")).toBe("_sproutos-challenge.example.com")
  })
})

describe("normalizeCustomDomainHostname", () => {
  it("stores one canonical IDNA A-label", () => {
    expect(normalizeCustomDomainHostname(" BÜCHER.example. ")).toBe("xn--bcher-kva.example")
  })

  it("refuses invalid labels and IP-shaped authorities", () => {
    expect(normalizeCustomDomainHostname("-bad.example")).toBeNull()
    expect(normalizeCustomDomainHostname("localhost")).toBeNull()
    expect(normalizeCustomDomainHostname("127.0.0.1")).toBeNull()
    expect(normalizeCustomDomainHostname("example.com:443")).toBeNull()
  })
})

describe("managed hostnames", () => {
  const policies = [
    {
      id: "policy-a",
      suffix: "sproutos.biz",
      organizationId: "organization-a",
      status: "active",
    },
  ]

  it("binds exactly one ASCII label to the owning organization", () => {
    expect(
      classifyManagedHostname("Example.SproutOS.Biz.", "example.sproutos.biz", policies),
    ).toEqual({
      policyId: "policy-a",
      organizationId: "organization-a",
    })
  })

  it.each([
    ["sproutos.biz", "single-label"],
    ["nested.example.sproutos.biz", "single-label"],
    ["*.sproutos.biz", "ASCII"],
    ["www.sproutos.biz", "reserved"],
    ["xn--bcher-kva.sproutos.biz", "ASCII"],
  ])("rejects %s", (hostname, reason) => {
    const result = classifyManagedHostname(hostname, hostname, policies)
    expect(result).not.toBeNull()
    expect(result !== null && "error" in result ? result.error : "").toContain(reason)
  })

  it("does not turn a disabled managed suffix into an ordinary TXT claim", () => {
    expect(
      classifyManagedHostname("shop.sproutos.biz", "shop.sproutos.biz", [
        { ...policies[0], status: "disabled" },
      ]),
    ).toEqual({ error: "Managed hostnames under this suffix are currently disabled" })
  })

  it("leaves unrelated customer domains on the ordinary verification path", () => {
    expect(classifyManagedHostname("shop.example.com", "shop.example.com", policies)).toBeNull()
  })
})
