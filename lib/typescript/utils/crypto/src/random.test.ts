import { describe, expect, it } from "vitest"
import { generateSessionToken, generateUrlSafeToken, randomBytes } from "./random"

describe("randomBytes", () => {
  it("returns the requested length", () => {
    expect(randomBytes(20)).toHaveLength(20)
    expect(randomBytes(0)).toHaveLength(0)
  })

  it("does not repeat across calls", () => {
    const seen = new Set(Array.from({ length: 100 }, () => randomBytes(16).join(",")))
    expect(seen.size).toBe(100)
  })
})

describe("generateSessionToken", () => {
  it("is 32 base32 characters, matching 20 bytes of entropy", () => {
    const token = generateSessionToken()
    expect(token).toHaveLength(32)
    expect(token).toMatch(/^[a-z2-7]{32}$/)
  })

  it("is unique across calls", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSessionToken()))
    expect(seen.size).toBe(100)
  })
})

describe("generateUrlSafeToken", () => {
  it("is URL-safe and unpadded", () => {
    expect(generateUrlSafeToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("encodes 32 bytes into 43 characters by default", () => {
    expect(generateUrlSafeToken()).toHaveLength(43)
  })

  it("honours an explicit byte length", () => {
    expect(generateUrlSafeToken(16)).toHaveLength(22)
  })
})
