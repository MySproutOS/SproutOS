import { encodeBase64UrlNoPadding } from "@utils/crypto"
import { describe, expect, it } from "vitest"
import { OAuth2ResponseError } from "./errors"
import { GOOGLE_SCOPES, generateCodeVerifier, generateState, parseGoogleIdToken } from "./google"
import { decodeJwtPayload } from "./jwt"

const rawSegment = (text: string): string =>
  encodeBase64UrlNoPadding(new TextEncoder().encode(text))

const jsonSegment = (value: unknown): string => rawSegment(JSON.stringify(value))

/** Build an unsigned JWT with the given payload. The signature is never checked, by design. */
function makeJwt(payload: Record<string, unknown>): string {
  return `${jsonSegment({ alg: "RS256", typ: "JWT" })}.${jsonSegment(payload)}.signature-not-verified`
}

const validClaims = {
  sub: "1234567890",
  email: "person@example.com",
  email_verified: true,
  name: "A Person",
  picture: "https://example.com/photo.jpg",
  exp: 1_800_000_000,
}

describe("decodeJwtPayload", () => {
  it("reads the payload segment", () => {
    expect(decodeJwtPayload(makeJwt({ sub: "abc" }))).toEqual({ sub: "abc" })
  })

  it("handles non-ASCII claims", () => {
    expect(decodeJwtPayload(makeJwt({ name: "Zoë Ünicode" })).name).toBe("Zoë Ünicode")
  })

  it.each([
    ["too few segments", "header.payload"],
    ["too many segments", "a.b.c.d"],
    ["empty string", ""],
  ])("rejects a malformed token (%s)", (_label, jwt) => {
    expect(() => decodeJwtPayload(jwt)).toThrow(OAuth2ResponseError)
  })

  it("rejects a payload that is not a JSON object", () => {
    expect(() => decodeJwtPayload(`${rawSegment("{}")}.${rawSegment("[1,2]")}.sig`)).toThrow(
      OAuth2ResponseError,
    )
    expect(() => decodeJwtPayload(`${rawSegment("{}")}.${rawSegment("not json")}.sig`)).toThrow(
      OAuth2ResponseError,
    )
  })
})

describe("parseGoogleIdToken", () => {
  it("maps the claims we rely on", () => {
    expect(parseGoogleIdToken(makeJwt(validClaims))).toEqual({
      sub: "1234567890",
      email: "person@example.com",
      emailVerified: true,
      name: "A Person",
      picture: "https://example.com/photo.jpg",
      exp: 1_800_000_000,
    })
  })

  it("nulls optional claims rather than inventing values", () => {
    const { name: _name, picture: _picture, ...withoutOptional } = validClaims
    const claims = parseGoogleIdToken(makeJwt(withoutOptional))
    expect(claims.name).toBeNull()
    expect(claims.picture).toBeNull()
  })

  it("treats a missing or non-true email_verified as unverified", () => {
    expect(
      parseGoogleIdToken(makeJwt({ ...validClaims, email_verified: "true" })).emailVerified,
    ).toBe(false)
    const { email_verified: _emailVerified, ...withoutFlag } = validClaims
    expect(parseGoogleIdToken(makeJwt(withoutFlag)).emailVerified).toBe(false)
  })

  it.each(["sub", "email", "exp"])("rejects a token missing the required claim %s", (claim) => {
    const { [claim]: _removed, ...incomplete } = validClaims as Record<string, unknown>
    expect(() => parseGoogleIdToken(makeJwt(incomplete))).toThrow(OAuth2ResponseError)
  })

  it("rejects claims of the wrong type", () => {
    expect(() => parseGoogleIdToken(makeJwt({ ...validClaims, sub: 123 }))).toThrow(
      OAuth2ResponseError,
    )
    expect(() => parseGoogleIdToken(makeJwt({ ...validClaims, exp: "soon" }))).toThrow(
      OAuth2ResponseError,
    )
  })
})

describe("state and PKCE verifier generation", () => {
  it("produces URL-safe values", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("produces a verifier within the length RFC 7636 allows", () => {
    const verifier = generateCodeVerifier()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 100 }, generateState)).size).toBe(100)
  })
})

describe("GOOGLE_SCOPES", () => {
  it("requests openid so an ID token comes back", () => {
    expect(GOOGLE_SCOPES).toContain("openid")
  })
})
