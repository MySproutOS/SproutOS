import { describe, expect, it } from "vitest"
import { loginPathForReturnTo, providerLoginPath, sanitizeReturnTo } from "./return-to"

/**
 * This function is the whole open-redirect defence: its output becomes a `Location` header on a
 * page anyone can link to. Every case below is a real bypass of the obvious `startsWith("/")`
 * check, which is why the check is not the obvious one.
 */
describe("sanitizeReturnTo", () => {
  it("accepts a path on this site", () => {
    expect(sanitizeReturnTo("/store/linkding")).toBe("/store/linkding")
    expect(sanitizeReturnTo("/store?tag=notes")).toBe("/store?tag=notes")
  })

  it("refuses an absolute URL", () => {
    expect(sanitizeReturnTo("https://evil.example/phish")).toBeNull()
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull()
  })

  it("refuses a protocol-relative URL, which passes a naive leading-slash check", () => {
    // Browsers follow //evil.example off-site. It starts with "/".
    expect(sanitizeReturnTo("//evil.example")).toBeNull()
    expect(sanitizeReturnTo("//evil.example/store/linkding")).toBeNull()
  })

  it("refuses a backslash, which some browsers normalize to a slash", () => {
    expect(sanitizeReturnTo("/\\evil.example")).toBeNull()
  })

  it("treats nothing as nothing", () => {
    expect(sanitizeReturnTo(null)).toBeNull()
    expect(sanitizeReturnTo("")).toBeNull()
  })
})

describe("login return paths", () => {
  it("preserves a protected path and its query string", () => {
    expect(loginPathForReturnTo("/orgs/acme/projects?view=groups")).toBe(
      "/login?next=%2Forgs%2Facme%2Fprojects%3Fview%3Dgroups",
    )
    expect(providerLoginPath("google", "/orgs/acme/projects?view=groups")).toBe(
      "/login/google?next=%2Forgs%2Facme%2Fprojects%3Fview%3Dgroups",
    )
  })

  it("drops an unsafe return destination", () => {
    expect(loginPathForReturnTo("https://evil.example/phish")).toBe("/login")
    expect(providerLoginPath("github", "//evil.example/phish")).toBe("/login/github")
  })
})
