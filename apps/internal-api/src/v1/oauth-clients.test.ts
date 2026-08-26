/* oxlint-disable no-await-in-loop */
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * Registering an application against our own OAuth provider.
 *
 * The assertions worth having are not that a client can be created. They are the five ways the
 * surface must refuse: a secret for a public client, a secret readable twice, a redirect URI that
 * would leak an authorization code, another organization's client, and a developer marking their
 * own app as verified.
 */
const up = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

let owner: TestUser | undefined
let stranger: TestUser | undefined
let orgSlug = ""
let strangerOrgSlug = ""

const confidential = {
  name: "A confidential app",
  homepageUrl: "https://example.com",
  clientType: "confidential" as const,
  redirectUris: ["https://example.com/callback"],
}

/**
 * Each suite creates its own organization through the API.
 *
 * `createTestUser` gives a user, not an organization the org-scoped routes can resolve — asking for
 * one by its slug answers "Organization not found", which reads exactly like a broken route and is
 * not one.
 */
async function makeOrg(user: TestUser, name: string): Promise<string> {
  const created = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: `${name} ${v7()}` }),
  })
  const organization = (await created.json()) as Json
  trackOrganization(organization.id as string)
  return organization.slug as string
}

beforeAll(async () => {
  if (!up) return
  owner = await createTestUser("oauthclient")
  stranger = await createTestUser("oauthstranger")
  orgSlug = await makeOrg(owner, "OAuth Client Suite")
  strangerOrgSlug = await makeOrg(stranger, "OAuth Stranger Suite")
})

afterAll(async () => {
  if (!up) return
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("oauth client registration", () => {
  it("issues a secret exactly once, and never returns it again", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, confidential)
    expect(created.status).toBe(201)

    /*
      A string, which is what `oauthClientsSchemaCreateResponse` declares.

      This asserted an object — `{ id, secret, lastFour }` — which is what the handler used to
      return in contradiction of its own schema, and is why the dashboard threw React error #31
      trying to render it. Asserting the shape the code happened to produce, rather than the shape
      the contract promises, is what let the two disagree.
    */
    const secret = created.json.secret
    expect(secret, "a confidential client must be given a secret on creation").toBeDefined()
    expect(typeof secret).toBe("string")
    expect(String(secret)).toMatch(/^client_secret_/)

    const id = String(created.json.id)

    // Every later read: the secret is listed, and its value is not in the response at all.
    const listed = await call("GET", `/v1/orgs/${orgSlug}/oauth-clients/${id}/secrets`, owner!)
    expect(listed.status).toBe(200)
    const items = listed.json.items as Json[]
    expect(items).toHaveLength(1)
    expect(items[0].lastFour).toBe(String(secret).slice(-4))
    expect(JSON.stringify(listed.json)).not.toContain(String(secret))

    // And it is not recoverable from the client itself either.
    const fetched = await call("GET", `/v1/orgs/${orgSlug}/oauth-clients/${id}`, owner!)
    expect(JSON.stringify(fetched.json)).not.toContain(String(secret))
  })

  it("only stores a hash, so the database cannot impersonate the client", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Hash check",
    })
    const secret = String(created.json.secret)

    const row = await db
      .selectFrom("oauthClientSecret")
      .select(["secretHash"])
      .where("oauthClientId", "=", String(created.json.id))
      .executeTakeFirstOrThrow()

    expect(row.secretHash).toMatch(/^sha256\$/)
    expect(row.secretHash).not.toContain(secret)
  })

  /*
    The secret a client is handed must authenticate it at the token endpoint.

    That sounds too obvious to test, and it is exactly what shipped broken: registration stored
    `sha256$<hex>` while `authenticateClient` compared a bare `<hex>`, so every confidential client
    got `invalid_client` no matter what it presented. Both files read correctly on their own — the
    mismatch only exists between them, which is why neither file's tests caught it. The suites here
    stopped at "a hash is stored", and the OAuth suite only ever exercised public clients, which
    return before the comparison because they have no secret.

    So the assertion has to cross the seam: mint through the real route, present through the real
    token endpoint. The grant is deliberately junk, because the grant is not what is under test —
    `invalid_grant` means client authentication *passed* and the exchange got as far as looking the
    code up, which is the whole claim. Before the fix this failed with `invalid_client`.
  */
  it("issues a secret that actually authenticates at the token endpoint", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Token endpoint round trip",
      redirectUris: ["https://example.com/callback"],
    })
    expect(created.status).toBe(201)
    const secret = String(created.json.secret)

    const response = await app.request("/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: String(created.json.id),
        client_secret: secret,
        code: "not-a-real-authorization-code",
        redirect_uri: "https://example.com/callback",
        code_verifier: "x".repeat(43),
      }),
    })
    const body = (await response.json()) as Json

    expect(body.error, `client authentication failed: ${JSON.stringify(body)}`).not.toBe(
      "invalid_client",
    )
    expect(body.error).toBe("invalid_grant")
  })

  // The other half of the seam, asserted directly: a wrong secret must still be refused. A fix
  // that made the comparison always succeed would satisfy the test above on its own.
  it("refuses a secret that was never issued", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Wrong secret",
    })

    const response = await app.request("/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: String(created.json.id),
        client_secret: "client_secret_this-was-never-issued-to-anyone",
        code: "not-a-real-authorization-code",
        redirect_uri: "https://example.com/callback",
        code_verifier: "x".repeat(43),
      }),
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Json).error).toBe("invalid_client")
  })

  it("gives a public client no secret at all", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      name: "A single-page app",
      homepageUrl: "https://spa.example.com",
      clientType: "public",
      redirectUris: ["https://spa.example.com/callback"],
    })

    expect(created.status).toBe(201)
    // A secret shipped to a browser is not a secret. Its absence is what forces PKCE.
    expect(created.json.secret).toBeUndefined()

    const refused = await call(
      "POST",
      `/v1/orgs/${orgSlug}/oauth-clients/${String(created.json.id)}/secrets`,
      owner!,
    )
    expect(refused.status).toBe(400)
  })

  it("refuses redirect URIs that would leak an authorization code", async () => {
    const bad = [
      // Plain HTTP off localhost: the code crosses the network in clear.
      "http://example.com/callback",
      // A fragment is never sent to the server.
      "https://example.com/callback#tok",
      // Relative: resolves against whatever origin is current.
      "/callback",
      "javascript:alert(1)",
    ]

    for (const uri of bad) {
      const attempt = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
        ...confidential,
        name: `bad ${uri}`,
        redirectUris: [uri],
      })
      expect(attempt.status, `${uri} was accepted`).toBe(400)
    }

    // Localhost over http is the documented exception, for a native app's loopback listener.
    const localhost = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "native app",
      redirectUris: ["http://localhost:8976/callback"],
    })
    expect(localhost.status).toBe(201)
  })

  it("replaces redirect URIs rather than adding to them", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Redirects",
      redirectUris: ["https://example.com/one", "https://example.com/two"],
    })
    const id = String(created.json.id)

    const updated = await call("PATCH", `/v1/orgs/${orgSlug}/oauth-clients/${id}`, owner!, {
      redirectUris: ["https://example.com/three"],
    })

    // The old two are gone. An "add" API would leave them registered, and a URI nobody meant to
    // keep is the one an attacker registers a lookalike host for.
    expect(updated.json.redirectUris).toEqual(["https://example.com/three"])
  })

  it("does not let one organization see or edit another's client", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Private to its org",
    })
    const id = String(created.json.id)

    // The stranger asks for it under their *own* organization, which is the realistic attempt: a
    // slug they are entitled to, an id they are not.
    const read = await call("GET", `/v1/orgs/${strangerOrgSlug}/oauth-clients/${id}`, stranger!)
    expect(read.status).toBe(404)

    const edited = await call(
      "PATCH",
      `/v1/orgs/${strangerOrgSlug}/oauth-clients/${id}`,
      stranger!,
      {
        name: "taken over",
      },
    )
    expect(edited.status).toBe(404)

    const still = await call("GET", `/v1/orgs/${orgSlug}/oauth-clients/${id}`, owner!)
    expect(still.json.name).toBe("Private to its org")
  })

  it("will not let a developer mark their own client verified or first-party", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Not ours",
      isVerified: true,
      isFirstParty: true,
    })

    // Both are shown on the consent screen, where a user decides whether to trust an app. A
    // developer who could set them could make their app look like ours at exactly that moment.
    expect(created.json.isVerified).toBe(false)
    expect(created.json.isFirstParty).toBe(false)
  })

  it("suspends without destroying the record of what users authorized", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Suspendable",
    })
    const id = String(created.json.id)

    const suspended = await call("PUT", `/v1/orgs/${orgSlug}/oauth-clients/${id}/status`, owner!, {
      status: "suspended",
    })
    expect(suspended.status).toBe(200)

    const row = await db
      .selectFrom("oauthClient")
      .select(["status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe("suspended")
  })

  it("revokes a secret without deleting it", async () => {
    const created = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients`, owner!, {
      ...confidential,
      name: "Rotation",
    })
    const id = String(created.json.id)

    // A second secret, so rotation does not require breaking every running instance of the app.
    const second = await call("POST", `/v1/orgs/${orgSlug}/oauth-clients/${id}/secrets`, owner!)
    expect(second.status).toBe(201)

    const revoked = await call(
      "DELETE",
      `/v1/orgs/${orgSlug}/oauth-clients/${id}/secrets/${String(second.json.id)}`,
      owner!,
    )
    expect(revoked.status).toBe(200)

    const listed = await call("GET", `/v1/orgs/${orgSlug}/oauth-clients/${id}/secrets`, owner!)
    const items = listed.json.items as Json[]
    // Still two rows: "which credential authenticated this call last March" is the question an
    // incident asks, and a deleted row cannot answer it.
    expect(items).toHaveLength(2)
    expect(items.filter((row) => row.revokedAt !== null)).toHaveLength(1)
  })
})
