import { describe, expect, it } from "vitest"
import { scopeLabel } from "./oauth-grants"

describe("OAuth grant scope labels", () => {
  it.each([
    ["openid", "Identify your SproutOS account"],
    ["email", "See your email address"],
    ["profile", "See your name"],
    ["github:identity", "Identify your GitHub contributions"],
  ])("describes %s in plain language", (scope, label) => {
    expect(scopeLabel(scope)).toBe(label)
  })
})
