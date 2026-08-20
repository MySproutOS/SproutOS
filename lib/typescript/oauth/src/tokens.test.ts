import { describe, expect, it } from "vitest"
import { parseTokenResponse } from "./tokens"

describe("parseTokenResponse scope delimiters", () => {
  it("splits GitHub's comma-delimited scopes", () => {
    // GitHub deviates from RFC 6749's space delimiter. A space-only split turned
    // this into one bogus scope, and step-up re-auth then believed it had been
    // granted nothing it recognised.
    const tokens = parseTokenResponse({
      access_token: "gho_x",
      scope: "repo,read:user,user:email",
    })
    expect(tokens.scopes).toEqual(["repo", "read:user", "user:email"])
  })

  it("splits the RFC's space-delimited scopes", () => {
    const tokens = parseTokenResponse({
      access_token: "ya29",
      scope: "openid email profile",
    })
    expect(tokens.scopes).toEqual(["openid", "email", "profile"])
  })

  it("tolerates mixed and repeated delimiters", () => {
    const tokens = parseTokenResponse({ access_token: "t", scope: "a, b ,  c" })
    expect(tokens.scopes).toEqual(["a", "b", "c"])
  })

  it("treats an absent scope as 'exactly what was asked for'", () => {
    expect(parseTokenResponse({ access_token: "t" }).scopes).toEqual([])
  })
})
