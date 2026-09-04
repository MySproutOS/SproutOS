import { describe, expect, it } from "vitest"
import { describeScope } from "./consent-form"

describe("OAuth identity scope descriptions", () => {
  it.each([
    ["openid", { action: "Identify", resource: "SproutOS account" }],
    ["email", { action: "See", resource: "email address" }],
    ["profile", { action: "See", resource: "name" }],
    ["github:identity", { action: "Identify", resource: "GitHub contributions" }],
  ])("describes %s in plain language", (scope, description) => {
    expect(describeScope(scope)).toEqual(description)
  })
})
