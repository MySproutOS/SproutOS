import { describe, expect, it } from "vitest"
import { intersectScopes } from "./index"

describe("OAuth-derived API key scope intersection", () => {
  it("keeps only authority covered by both the key and its live grant", () => {
    expect(intersectScopes(["*"], ["project:read", "deployment:write"])).toEqual([
      "project:read",
      "deployment:write",
    ])
    expect(intersectScopes(["project:*", "deployment:read"], ["project:read", "*"])).toEqual([
      "project:*",
      "deployment:read",
    ])
    expect(intersectScopes(["workflow:*"], ["workflow:job:read"])).toEqual(["workflow:job:read"])
    expect(intersectScopes(["project:read"], ["deployment:write"])).toEqual([])
  })
})
