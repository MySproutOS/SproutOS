import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { encodeHexLowerCase } from "./encoding"
import { constantTimeEqual, constantTimeEqualUtf8, sha256, sha256Utf8 } from "./hash"

describe("sha256", () => {
  it("matches the published digest of the empty string", async () => {
    expect(encodeHexLowerCase(await sha256(new Uint8Array([])))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  it("matches the published digest of 'abc'", async () => {
    expect(encodeHexLowerCase(await sha256Utf8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("agrees with node:crypto across a range of inputs", async () => {
    const inputs = ["", "a", "session-token", "🔐 unicode", "x".repeat(1000)]
    const actual = await Promise.all(
      inputs.map(async (input) => encodeHexLowerCase(await sha256Utf8(input))),
    )
    expect(actual).toEqual(
      inputs.map((input) => createHash("sha256").update(input, "utf8").digest("hex")),
    )
  })
})

describe("constantTimeEqual", () => {
  it("is true for identical contents", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
  })

  it("is false when any byte differs", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })

  it("is false for differing lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it("is true for two empty arrays", () => {
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true)
  })

  it("compares strings by their UTF-8 bytes", () => {
    expect(constantTimeEqualUtf8("state-abc", "state-abc")).toBe(true)
    expect(constantTimeEqualUtf8("state-abc", "state-abd")).toBe(false)
    expect(constantTimeEqualUtf8("state", "")).toBe(false)
  })
})
