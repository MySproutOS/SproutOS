import { describe, expect, it } from "vitest"
import { sanitizeReturnTo } from "./return-to"

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
