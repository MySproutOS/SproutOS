import { describe, expect, it } from "vitest"
import { looksLikeApex, verificationName } from "./custom-domains"

/**
 * The apex heuristic decides which record a customer is told to create, and it is the one place
 * here where the obvious implementation is wrong.
 */
describe("looksLikeApex", () => {
  it("treats a two-label name as an apex", () => {
    expect(looksLikeApex("example.com")).toBe(true)
    expect(looksLikeApex("textscam.com")).toBe(true)
  })

  it("treats a subdomain as not an apex", () => {
    expect(looksLikeApex("www.example.com")).toBe(false)
    expect(looksLikeApex("api.staging.example.com")).toBe(false)
  })

  /*
    The case dot-counting gets wrong.

    `example.co.uk` and `www.example.com` both have two dots and three labels, and they need
    opposite records — an A at the apex, a CNAME at the subdomain. A customer told to CNAME their
    apex is refused by their own DNS provider.
  */
  it("treats a multi-label public suffix as an apex", () => {
    expect(looksLikeApex("example.co.uk")).toBe(true)
    expect(looksLikeApex("shop.com.au")).toBe(true)
  })

  it("still treats a subdomain under a multi-label suffix as not an apex", () => {
    expect(looksLikeApex("www.example.co.uk")).toBe(false)
  })
})

describe("verificationName", () => {
  it("is a dedicated label, so it cannot collide with the customer's own TXT records", () => {
    // A verification token published at the apex would sit alongside SPF, DKIM and every
    // site-verification string the customer already has — and a tool that rewrites those wholesale
    // would silently drop ours.
    expect(verificationName("example.com")).toBe("_sproutos-challenge.example.com")
  })
})
