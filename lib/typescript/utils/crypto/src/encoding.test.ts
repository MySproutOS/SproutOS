import { describe, expect, it } from "vitest"
import {
  decodeBase64UrlToBytes,
  encodeBase32LowerCaseNoPadding,
  encodeBase64,
  encodeBase64UrlNoPadding,
  encodeHexLowerCase,
} from "./encoding"

const utf8 = (s: string) => new TextEncoder().encode(s)

describe("encodeHexLowerCase", () => {
  it("encodes two lowercase characters per byte", () => {
    expect(encodeHexLowerCase(new Uint8Array([0x00, 0x0f, 0xa0, 0xff]))).toBe("000fa0ff")
  })

  it("encodes empty input as an empty string", () => {
    expect(encodeHexLowerCase(new Uint8Array([]))).toBe("")
  })
})

// RFC 4648 section 10 test vectors, lowercased with padding stripped.
describe("encodeBase32LowerCaseNoPadding", () => {
  it.each([
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ])("encodes %o as %o", (input, expected) => {
    expect(encodeBase32LowerCaseNoPadding(utf8(input))).toBe(expected)
  })

  it("uses the full alphabet without padding characters", () => {
    const encoded = encodeBase32LowerCaseNoPadding(
      new Uint8Array(Array.from({ length: 40 }, (_, i) => i * 6)),
    )
    expect(encoded).toMatch(/^[a-z2-7]+$/)
  })

  it("produces 32 characters for a 20-byte session token", () => {
    expect(encodeBase32LowerCaseNoPadding(new Uint8Array(20))).toHaveLength(32)
  })
})

// RFC 4648 section 10 test vectors.
describe("encodeBase64", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ])("encodes %o as %o", (input, expected) => {
    expect(encodeBase64(utf8(input))).toBe(expected)
  })

  it("matches the platform encoder for arbitrary bytes", () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
  })
})

describe("encodeBase64UrlNoPadding", () => {
  it("uses - and _ instead of + and /, and drops padding", () => {
    // 0xfb 0xff encodes to "+/" in the last two characters under the standard alphabet.
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe])
    expect(encodeBase64(bytes)).toBe("+//+")
    expect(encodeBase64UrlNoPadding(bytes)).toBe("-__-")
  })

  it("matches the platform base64url encoder for arbitrary bytes", () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    expect(encodeBase64UrlNoPadding(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
  })

  it("never emits characters that need URL escaping", () => {
    const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) % 256))
    expect(encodeBase64UrlNoPadding(bytes)).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("decodeBase64UrlToBytes", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    expect(decodeBase64UrlToBytes(encodeBase64UrlNoPadding(bytes))).toEqual(bytes)
  })

  it("accepts the standard alphabet and padding too", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe])
    expect(decodeBase64UrlToBytes(encodeBase64(bytes))).toEqual(bytes)
    expect(decodeBase64UrlToBytes("Zm8=")).toEqual(new TextEncoder().encode("fo"))
  })

  it("decodes a UTF-8 JWT-style payload without mangling non-ASCII", () => {
    const json = JSON.stringify({ name: "Zoë Ünicode", sub: "123" })
    const encoded = encodeBase64UrlNoPadding(new TextEncoder().encode(json))
    expect(new TextDecoder().decode(decodeBase64UrlToBytes(encoded))).toBe(json)
  })

  it("throws on characters outside the alphabet", () => {
    expect(() => decodeBase64UrlToBytes("abc!def")).toThrow(SyntaxError)
  })
})
