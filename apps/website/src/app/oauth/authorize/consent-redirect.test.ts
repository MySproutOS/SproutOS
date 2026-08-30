import { describe, expect, it } from "vitest"
import { deniedAuthorizationRedirect } from "./consent-redirect"

describe("OAuth consent refusal", () => {
  it("returns access_denied and preserves state", () => {
    const target = new URL(
      deniedAuthorizationRedirect("http://127.0.0.1:8787/callback?existing=yes", "csrf-state"),
    )

    expect(target.origin + target.pathname).toBe("http://127.0.0.1:8787/callback")
    expect(target.searchParams.get("existing")).toBe("yes")
    expect(target.searchParams.get("error")).toBe("access_denied")
    expect(target.searchParams.get("error_description")).toBe("The user declined the request")
    expect(target.searchParams.get("state")).toBe("csrf-state")
  })

  it("does not manufacture state when the client supplied none", () => {
    const target = new URL(deniedAuthorizationRedirect("https://client.example/callback", null))
    expect(target.searchParams.has("state")).toBe(false)
  })
})
