import { describe, expect, it } from "vitest"
import app from "../index"

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
