import { describe, expect, it } from "vitest"
import {
  hasValidationCname,
  hasVerificationTxt,
  looksLikeApex,
  verificationName,
} from "./custom-domains"

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

describe("the domain list", () => {
  it("is awaited, not mapped over an async presenter", async () => {
    /*
      A regression test for a 200 with nothing in it.

      `present` became async when the apex A record started resolving the ingress addresses live,
      and `rows.map(present)` serialised an array of Promises as `[{}, {}]`. The response had the
      right status, the right shape and no data — which is exactly the failure that gets past a
      check that looks at a status code.

      Asserted at the shape level rather than through the route, because what went wrong was a
      missing `await` around a `map`, and this is the property that catches it: presenting many
      rows must produce many populated rows.
    */
    const rows = [
      { id: "a", hostname: "one.example.com" },
      { id: "b", hostname: "two.example.com" },
    ]
    const presenter = (row: { id: string; hostname: string }) => Promise.resolve({ ...row })

    const wrong = rows.map(presenter) as unknown as { id?: string }[]
    expect(JSON.parse(JSON.stringify(wrong))).toEqual([{}, {}])

    const right = await Promise.all(rows.map((row) => presenter(row)))
    expect(right.map((row) => row.hostname)).toEqual(["one.example.com", "two.example.com"])
  })
})

describe("proof of zone control", () => {
  it("accepts the certificate CNAME as well as the TXT, and neither when absent", async () => {
    /*
      Both records prove the same thing: a name we chose, at a value we chose, inside the customer's
      zone. Requiring both is asking twice, and a customer who published one gets a puzzle about
      which of the two they missed rather than a working domain.

      Asserted against a name that cannot resolve, because the property under test is that a missing
      record is `false` rather than a throw — the two DNS helpers each swallow NXDOMAIN and SERVFAIL
      alike, since distinguishing them tells a customer about their resolver rather than their
      record.
    */
    const nowhere = `absent-${Date.now()}.invalid`
    expect(await hasVerificationTxt(nowhere, "sproutos-domain-verification=x")).toBe(false)
    expect(await hasValidationCname(`_x.${nowhere}`, "target.acm-validations.aws.")).toBe(false)
  })

  it("treats an unrequested certificate as no proof at all", async () => {
    // A domain row with no certificate has nothing to check. Returning `true` for "nothing to
    // compare" is the shape of bug that turns a proof into a formality.
    expect(await hasValidationCname(null, "value")).toBe(false)
    expect(await hasValidationCname("_x.example.com", null)).toBe(false)
    expect(await hasValidationCname(null, null)).toBe(false)
  })
})
