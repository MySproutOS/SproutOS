import { describe, expect, it } from "vitest"
import { readBearerToken, scopesCover } from "./oauth-bearer"

describe("readBearerToken", () => {
  it("reads a well-formed header", () => {
    expect(readBearerToken("Bearer abc123")).toBe("abc123")
    // Schemes are case-insensitive per RFC 7235, and clients do send "bearer".
    expect(readBearerToken("bearer abc123")).toBe("abc123")
    expect(readBearerToken("  Bearer   abc123  ")).toBe("abc123")
  })

  it("ignores anything that is not a bearer token", () => {
    expect(readBearerToken(undefined)).toBeNull()
    expect(readBearerToken("Basic dXNlcjpwdw==")).toBeNull()
    expect(readBearerToken("Bearer")).toBeNull()
    expect(readBearerToken("abc123")).toBeNull()
    // Two values is malformed, not a token with a space in it.
    expect(readBearerToken("Bearer abc 123")).toBeNull()
  })
})

describe("scopesCover", () => {
  it("matches an exact scope", () => {
    expect(scopesCover(["project:read"], "project:read")).toBe(true)
    expect(scopesCover(["project:read"], "project:delete")).toBe(false)
  })

  it("honours the wildcard shape the RBAC catalogue already uses", () => {
    expect(scopesCover(["project:*"], "project:read")).toBe(true)
    expect(scopesCover(["*"], "billing:refund")).toBe(true)
    expect(scopesCover(["workflow:job:*"], "workflow:job:modify")).toBe(true)
    expect(scopesCover(["workflow:*"], "workflow:job:modify")).toBe(true)
  })

  it("does not let a narrow wildcard widen", () => {
    // The trap: `project:read:*` must not cover `project:read`, and a scope for one service must
    // never reach another.
    expect(scopesCover(["project:read:*"], "project:read")).toBe(false)
    expect(scopesCover(["project:*"], "billing:read")).toBe(false)
    expect(scopesCover([], "project:read")).toBe(false)
  })
})
