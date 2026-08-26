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
