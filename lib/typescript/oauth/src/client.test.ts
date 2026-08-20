import { afterEach, describe, expect, it, vi } from "vitest"
import { OAuth2Client, createS256CodeChallenge } from "./client"
import { OAuth2RequestError, OAuth2ResponseError } from "./errors"

const client = new OAuth2Client({
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://example.com/login/google/callback",
  endpoints: {
    authorization: "https://accounts.example.com/authorize",
    token: "https://oauth2.example.com/token",
  },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface RecordedRequest {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: URLSearchParams
}

/** Stub `fetch` with a canned token response and record what the client sent. */
function stubTokenResponse(body: unknown, init: { status?: number } = {}): RecordedRequest[] {
  const calls: RecordedRequest[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, requestInit: RequestInit) => {
      calls.push({
        url,
        method: requestInit.method,
        headers: requestInit.headers as Record<string, string>,
        body: new URLSearchParams(requestInit.body as string),
      })
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    }),
  )
  return calls
}

describe("createS256CodeChallenge", () => {
  // RFC 7636 appendix B publishes this verifier/challenge pair.
  it("matches the RFC 7636 test vector", async () => {
    expect(await createS256CodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })
})

describe("createAuthorizationUrl", () => {
  it("sets every parameter the provider needs", async () => {
    const url = await client.createAuthorizationUrl("the-state", "the-verifier", [
      "openid",
      "email",
    ])
    expect(url.origin + url.pathname).toBe("https://accounts.example.com/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-id")
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/login/google/callback")
    expect(url.searchParams.get("state")).toBe("the-state")
    expect(url.searchParams.get("scope")).toBe("openid email")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe(
      await createS256CodeChallenge("the-verifier"),
    )
  })

  it("never puts the verifier itself in the URL", async () => {
    const url = await client.createAuthorizationUrl("s", "super-secret-verifier", ["openid"])
    expect(url.toString()).not.toContain("super-secret-verifier")
  })

  it("omits scope when none are requested", async () => {
    const url = await client.createAuthorizationUrl("s", "v", [])
    expect(url.searchParams.has("scope")).toBe(false)
  })
})

describe("validateAuthorizationCode", () => {
  it("posts the code, verifier and redirect URI with Basic client auth", async () => {
    const calls = stubTokenResponse({ access_token: "at", token_type: "Bearer" })
    await client.validateAuthorizationCode("the-code", "the-verifier")

    const { url, method, headers, body } = calls[0]
    expect(url).toBe("https://oauth2.example.com/token")
    expect(method).toBe("POST")
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
    // base64("client-id:client-secret")
    expect(headers.Authorization).toBe("Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=")

    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("the-code")
    expect(body.get("code_verifier")).toBe("the-verifier")
    expect(body.get("redirect_uri")).toBe("https://example.com/login/google/callback")
    // The secret goes in the header, not the body.
    expect(body.has("client_secret")).toBe(false)
  })

  it("parses a full token response", async () => {
    stubTokenResponse({
      access_token: "at",
      token_type: "Bearer",
      id_token: "it",
      refresh_token: "rt",
      scope: "openid email",
      expires_in: 3599,
    })
    const tokens = await client.validateAuthorizationCode("c", "v")
    expect(tokens).toEqual({
      accessToken: "at",
      tokenType: "Bearer",
      idToken: "it",
      refreshToken: "rt",
      scopes: ["openid", "email"],
      accessTokenExpiresInSeconds: 3599,
    })
  })

  it("nulls optional fields the provider omitted", async () => {
    stubTokenResponse({ access_token: "at" })
    const tokens = await client.validateAuthorizationCode("c", "v")
    expect(tokens.idToken).toBeNull()
    expect(tokens.refreshToken).toBeNull()
    expect(tokens.accessTokenExpiresInSeconds).toBeNull()
    expect(tokens.scopes).toEqual([])
    expect(tokens.tokenType).toBe("bearer")
  })

  it("raises the provider's error code — a reused code is invalid_grant", async () => {
    stubTokenResponse(
      { error: "invalid_grant", error_description: "Code was already redeemed" },
      { status: 400 },
    )
    await expect(client.validateAuthorizationCode("c", "v")).rejects.toThrow(OAuth2RequestError)
    await expect(client.validateAuthorizationCode("c", "v")).rejects.toMatchObject({
      code: "invalid_grant",
      description: "Code was already redeemed",
    })
  })

  it("rejects a success response with no access token", async () => {
    stubTokenResponse({ token_type: "Bearer" })
    await expect(client.validateAuthorizationCode("c", "v")).rejects.toThrow(OAuth2ResponseError)
  })

  it("rejects a non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("<html>502</html>", { status: 502 }))),
    )
    await expect(client.validateAuthorizationCode("c", "v")).rejects.toThrow(OAuth2ResponseError)
  })

  it("wraps a network failure rather than leaking it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network down"))),
    )
    await expect(client.validateAuthorizationCode("c", "v")).rejects.toThrow(
      "Could not reach the token endpoint",
    )
  })
})

describe("refreshAccessToken", () => {
  it("sends the refresh_token grant", async () => {
    const calls = stubTokenResponse({ access_token: "new-at", token_type: "Bearer" })
    const tokens = await client.refreshAccessToken("the-refresh-token")

    const { body } = calls[0]
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("the-refresh-token")
    expect(tokens.accessToken).toBe("new-at")
  })
})
