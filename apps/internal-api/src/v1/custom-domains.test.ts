import { describe, expect, it } from "vitest"
import { looksLikeApex, verificationName } from "./custom-domains"

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

describe("verificationName", () => {
  it("uses an isolated ownership label", () => {
    expect(verificationName("example.com")).toBe("_sproutos-challenge.example.com")
  })
})
