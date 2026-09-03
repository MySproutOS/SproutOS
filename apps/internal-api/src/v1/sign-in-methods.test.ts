import { describe, expect, it } from "vitest"
import { hasRecentReauthentication, safeIdentityReturnPath } from "./sign-in-methods"

describe("sign-in method security helpers", () => {
  it("accepts only a recent reauthentication", () => {
    const now = new Date("2026-09-03T12:00:00.000Z")
    expect(hasRecentReauthentication(new Date("2026-09-03T11:59:00.000Z"), now)).toBe(true)
    expect(hasRecentReauthentication(new Date("2026-09-03T11:44:59.999Z"), now)).toBe(false)
    expect(hasRecentReauthentication(new Date("2026-09-03T12:00:00.001Z"), now)).toBe(false)
    expect(hasRecentReauthentication(null, now)).toBe(false)
  })

  it.each(["https://evil.example", "//evil.example/path", "/\\evil", "javascript:alert(1)"])(
    "rejects unsafe return path %s",
    (value) => {
      expect(safeIdentityReturnPath(value)).toBeNull()
    },
  )

  it("preserves a same-origin path, query, and fragment", () => {
    expect(safeIdentityReturnPath("/orgs/acme/settings/sign-in-methods?from=profile#methods")).toBe(
      "/orgs/acme/settings/sign-in-methods?from=profile#methods",
    )
  })
})
