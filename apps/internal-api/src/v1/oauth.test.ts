import { describe, expect, it } from "vitest"
import app from "../index"

async function token(clientId: string): Promise<Response> {
  return await app.request("/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: "client_secret_whatever",
      code: "irrelevant",
      redirect_uri: "https://example.com/callback",
      code_verifier: "x".repeat(43),
    }),
  })
}

/**
 * The discovery document, which is the only contract a third-party client has.
 *
 * A client reads this and posts its token exchange wherever it says. That makes a wrong URL here
 * worse than a broken endpoint: the endpoint is fine, and the client is simply pointed somewhere
 * else. This shipped advertising `${issuer}/api/v1/oauth/token` — the shape of the upstream
 * template, where the API is mounted inside Next.js. This platform serves the API from its own
 * host, so in production that path answered 307 and redirected to the login page. A client
 * following discovery correctly would have posted its client secret into an HTML redirect and
 * failed with nothing naming the cause.
 *
 * These assertions are about *which host*, not about spelling. `issuer` and the authorization
 * endpoint belong to the website — one is the identity tokens are minted under, the other is a
 * page a human visits — and everything a client calls machine-to-machine belongs to the API.
 */
describe("the OAuth discovery document", () => {
  const HOST = "https://sproutos.example"
  const API = "https://api.sproutos.example"

  async function discover() {
    process.env.NEXT_PUBLIC_HOST_URL = HOST
    process.env.NEXT_PUBLIC_API_URL = API
    const response = await app.request("/v1/oauth/.well-known/oauth-authorization-server")
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, string | string[]>
  }

  it("points the client-called endpoints at the API host", async () => {
    const document = await discover()

    expect(document.token_endpoint).toBe(`${API}/v1/oauth/token`)
    expect(document.introspection_endpoint).toBe(`${API}/v1/oauth/introspect`)
    expect(document.revocation_endpoint).toBe(`${API}/v1/oauth/revoke`)
    expect(document.userinfo_endpoint).toBe(`${API}/v1/oauth/userinfo`)
    expect(document.scopes_supported).toEqual(
      expect.arrayContaining(["openid", "email", "profile", "github:identity"]),
    )
  })

  it("keeps the issuer and the authorization page on the website host", async () => {
    const document = await discover()

    expect(document.issuer).toBe(HOST)
    expect(document.authorization_endpoint).toBe(`${HOST}/oauth/authorize`)
  })

  /*
    The specific regression, named. `/api/v1` is the upstream template's layout and is not a path
    this deployment serves anywhere — if it reappears in any advertised URL, a client following
    discovery is being sent to a redirect rather than an endpoint.
  */
  it("never advertises the embedded-API path", async () => {
    const document = await discover()

    // Collected first and asserted once, so the assertion runs whether or not anything matched —
    // a loop that only asserts inside a condition passes silently when the condition never holds.
    const advertised = Object.entries(document)
      .filter(([key, value]) => key.endsWith("_endpoint") && typeof value === "string")
      .map(([key, value]) => `${key}=${String(value)}`)

    expect(advertised.length).toBeGreaterThan(0)
    expect(advertised.filter((entry) => entry.includes("/api/v1/"))).toEqual([])
  })
})

/**
 * A malformed client id must be refused, not crash.
 *
 * `oauth_client.id` is a uuid column, so a lookup with anything else raises inside the driver.
 * That surfaced as `server_error` and a 500 on both the token and introspection endpoints, neither
 * of which requires authentication to reach — so any anonymous caller could produce a stack trace,
 * and the 500 distinguished "not a uuid" from the `invalid_client` an unknown-but-well-formed id
 * gets. The whole point of the flat `invalid_client` elsewhere in this file is that responses must
 * not separate those cases.
 *
 * These need no database: the shape check runs before any query, which is the fix.
 */
describe("a client id that is not a uuid", () => {
  it("is invalid_client at the token endpoint, not server_error", async () => {
    const response = await token("not-a-uuid")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: "invalid_client",
      error_description: "Unknown client",
    })
  })

  it("is invalid_client at the introspection endpoint too", async () => {
    // No `x-client-id` header at all, which is how this was first hit: the handler reads a missing
    // header as the empty string and takes it straight to the query.
    const response = await app.request("/v1/oauth/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "irrelevant" }),
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Record<string, string>).error).toBe("invalid_client")
  })

  /*
    The oracle, asserted directly. A well-formed id for a client that does not exist and a
    malformed id must be indistinguishable to the caller — otherwise the pair is an enumeration
    tool for the id format. This one does reach the database, so it is skipped without one.
  */
  it.skipIf(process.env.DATABASE_URL === undefined)(
    "is indistinguishable from a well-formed id that belongs to nobody",
    async () => {
      const malformed = await token("not-a-uuid")
      const unknown = await token("00000000-0000-4000-8000-000000000000")

      expect(malformed.status).toBe(unknown.status)
      expect(await malformed.json()).toEqual(await unknown.json())
    },
  )
})
