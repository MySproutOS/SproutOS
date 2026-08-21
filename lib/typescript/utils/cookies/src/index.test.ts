import { describe, expect, it } from "vitest"
import { apexDomain, cookieDomain } from "./index"

describe("cookieDomain", () => {
  it("is undefined with nothing configured, so the cookie stays host-only", () => {
    expect(cookieDomain({})).toBeUndefined()
  })

  it("is undefined on localhost, which Chrome rejects as a Domain attribute", () => {
    expect(cookieDomain({ NEXT_PUBLIC_HOST_URL: "http://localhost:3000" })).toBeUndefined()
    expect(cookieDomain({ NEXT_PUBLIC_HOST_URL: "http://127.0.0.1:3000" })).toBeUndefined()
  })

  it("derives the parent domain when the website is on the apex", () => {
    expect(cookieDomain({ NEXT_PUBLIC_HOST_URL: "https://example.com" })).toBe(".example.com")
  })

  /*
    The bug this package exists for.

    A website on `app.example.com` derives `.app.example.com`, and `api.example.com` is not under
    it — so the API receives no cookie and every authenticated request is anonymous. The derivation
    is asserted to be wrong here rather than quietly fixed, because it is still the right answer for
    the apex case above and the two cannot be told apart from the URL alone.
  */
  it("derives a domain the API cannot receive when the website is on a subdomain", () => {
    expect(cookieDomain({ NEXT_PUBLIC_HOST_URL: "https://app.example.com" })).toBe(
      ".app.example.com",
    )
  })

  it("takes SESSION_COOKIE_DOMAIN over the derivation, which is how a subdomain deploy works", () => {
    expect(
      cookieDomain({
        NEXT_PUBLIC_HOST_URL: "https://app.example.com",
        SESSION_COOKIE_DOMAIN: ".example.com",
      }),
    ).toBe(".example.com")
  })

  it("ignores an empty override rather than scoping the cookie to the empty string", () => {
    expect(
      cookieDomain({ NEXT_PUBLIC_HOST_URL: "https://example.com", SESSION_COOKIE_DOMAIN: "" }),
    ).toBe(".example.com")
  })

  it("applies the override on localhost too, since a proxy may map a real host there", () => {
    expect(
      cookieDomain({
        NEXT_PUBLIC_HOST_URL: "http://localhost:3000",
        SESSION_COOKIE_DOMAIN: ".test.local",
      }),
    ).toBe(".test.local")
  })
})

describe("apexDomain", () => {
  it("is the host, without a leading dot — CORS names origins, not subtrees", () => {
    expect(apexDomain({ NEXT_PUBLIC_HOST_URL: "https://app.example.com" })).toBe("app.example.com")
  })

  it("is not affected by the cookie override, which scopes a different thing", () => {
    expect(
      apexDomain({
        NEXT_PUBLIC_HOST_URL: "https://app.example.com",
        SESSION_COOKIE_DOMAIN: ".example.com",
      }),
    ).toBe("app.example.com")
  })

  it("is undefined when unset", () => {
    expect(apexDomain({})).toBeUndefined()
  })
})
