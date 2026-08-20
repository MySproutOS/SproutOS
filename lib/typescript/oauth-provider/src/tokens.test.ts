import { db } from "@sproutos/db"
import { encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { OAuthError } from "./errors"
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  hashToken,
  introspect,
  narrowScopes,
  revokeToken,
  rotateRefreshToken,
} from "./tokens"

/**
 * Against the compose Postgres, because the properties under test are database behaviours: a code
 * is single-use because an UPDATE with `consumed_at is null` in its WHERE races correctly, and a
 * refresh family is revoked by a statement. Neither survives being mocked.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const VERIFIER = "v".repeat(43)
const fixtures = { users: [] as string[], organizations: [] as string[] }

afterAll(async () => {
  if (!reachable) return
  if (fixtures.organizations.length > 0) {
    await db.deleteFrom("organization").where("id", "in", fixtures.organizations).execute()
  }
  if (fixtures.users.length > 0) {
    await db.deleteFrom("user").where("id", "in", fixtures.users).execute()
  }
  await db.destroy()
})

async function challenge(): Promise<string> {
  return encodeBase64UrlNoPadding(await sha256Utf8(VERIFIER))
}

/** A client, a user, an organization, and the grant that ties them together. */
async function grant() {
  const userId = v7()
  const organizationId = v7()
  const clientId = v7()
  const grantId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `oauth-${userId}@test.invalid`, name: "OAuth" })
    .execute()
  fixtures.users.push(userId)

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "OAuth Org",
      slug: `oauth-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  fixtures.organizations.push(organizationId)

  await db
    .insertInto("oauthClient")
    .values({
      id: clientId,
      ownerUserId: userId,
      organizationId,
      name: "Test Client",
      homepageUrl: "https://app.example.com",
      clientType: "public",
      defaultScopes: ["project:read"],
    })
    .execute()

  await db
    .insertInto("oauthGrant")
    .values({
      id: grantId,
      oauthClientId: clientId,
      userId,
      organizationId,
      scopes: ["project:read", "project:create"],
    })
    .execute()

  return { userId, organizationId, clientId, grantId }
}

async function issueCode(fixture: Awaited<ReturnType<typeof grant>>) {
  return await createAuthorizationCode(db, {
    oauthClientId: fixture.clientId,
    userId: fixture.userId,
    organizationId: fixture.organizationId,
    oauthGrantId: fixture.grantId,
    redirectUri: "https://app.example.com/callback",
    scopes: ["project:read"],
    codeChallenge: await challenge(),
  })
}

describe.skipIf(!reachable)("authorization codes", () => {
  it("exchanges once and never again", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const code = await issueCode(fixture)

    const tokens = await exchangeAuthorizationCode(db, {
      code,
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })
    expect(tokens.accessToken).not.toBe("")

    // A replayed code is exactly what an attacker who intercepted the redirect holds.
    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: fixture.clientId,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(OAuthError)
  })

  it("burns the code even when the verifier is wrong", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const code = await issueCode(fixture)

    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: fixture.clientId,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: "w".repeat(43),
      }),
    ).rejects.toThrow(/code_verifier/)

    // Leaving it alive would turn a failed verifier into a free retry — an attacker with a stolen
    // code could grind at PKCE until something worked.
    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: fixture.clientId,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(/invalid or has expired/)
  })

  it("refuses a code redeemed by a different client", async ({ skip }) => {
    if (!reachable) skip()
    const mine = await grant()
    const theirs = await grant()
    const code = await issueCode(mine)

    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: theirs.clientId,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(/another client/)
  })

  it("refuses a redirect_uri that differs at redemption", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const code = await issueCode(fixture)

    // Checked again here, not only at authorization: a code obtained through one registered URI
    // must not be redeemable against another.
    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: fixture.clientId,
        redirectUri: "https://app.example.com/other",
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(/redirect_uri/)
  })

  it("refuses an expired code", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const code = await issueCode(fixture)

    await db
      .updateTable("oauthAuthorizationCode")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("codeHash", "=", await hashToken(code))
      .execute()

    await expect(
      exchangeAuthorizationCode(db, {
        code,
        oauthClientId: fixture.clientId,
        redirectUri: "https://app.example.com/callback",
        codeVerifier: VERIFIER,
      }),
    ).rejects.toThrow(OAuthError)
  })
})

describe.skipIf(!reachable)("refresh rotation", () => {
  it("issues a new pair and retires the old refresh token", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const first = await exchangeAuthorizationCode(db, {
      code: await issueCode(fixture),
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })

    const second = await rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      oauthClientId: fixture.clientId,
    })

    expect(second.refreshToken).not.toBe(first.refreshToken)
    expect(second.accessToken).not.toBe(first.accessToken)
    expect((await introspect(db, second.accessToken)).active).toBe(true)
  })

  it("revokes the whole family when a refresh token is reused", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const first = await exchangeAuthorizationCode(db, {
      code: await issueCode(fixture),
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })
    const second = await rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      oauthClientId: fixture.clientId,
    })

    // A refresh token presented twice is either a client retrying a dropped response or an
    // attacker with a stolen copy, and there is no way to tell. OAuth 2.1 says assume theft.
    await expect(
      rotateRefreshToken(db, {
        refreshToken: first.refreshToken,
        oauthClientId: fixture.clientId,
      }),
    ).rejects.toThrow(/already been used/)

    // The legitimate holder is logged out too. That is the point: the alternative is a stolen
    // token working forever alongside the real one, silently.
    await expect(
      rotateRefreshToken(db, {
        refreshToken: second.refreshToken,
        oauthClientId: fixture.clientId,
      }),
    ).rejects.toThrow(/revoked/)

    // And the access token dies with it — leaving it live gives an attacker an hour after
    // detection, which is most of what they wanted.
    expect((await introspect(db, second.accessToken)).active).toBe(false)
  })

  it("refuses a refresh token belonging to another client", async ({ skip }) => {
    if (!reachable) skip()
    const mine = await grant()
    const theirs = await grant()
    const tokens = await exchangeAuthorizationCode(db, {
      code: await issueCode(mine),
      oauthClientId: mine.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })

    await expect(
      rotateRefreshToken(db, {
        refreshToken: tokens.refreshToken,
        oauthClientId: theirs.clientId,
      }),
    ).rejects.toThrow(/another client/)
  })
})

describe("narrowScopes", () => {
  it("keeps the grant's scopes when none are requested", () => {
    expect(narrowScopes(["a", "b"], undefined)).toEqual(["a", "b"])
    expect(narrowScopes(["a", "b"], [])).toEqual(["a", "b"])
  })

  it("allows narrowing", () => {
    expect(narrowScopes(["a", "b"], ["a"])).toEqual(["a"])
  })

  it("refuses widening", () => {
    // RFC 6749 §6. Otherwise a token granted project:read refreshes itself into project:delete.
    expect(() => narrowScopes(["project:read"], ["project:read", "project:delete"])).toThrow(
      OAuthError,
    )
  })
})

describe.skipIf(!reachable)("introspection and revocation", () => {
  it("reports an unknown token as inactive rather than erroring", async ({ skip }) => {
    if (!reachable) skip()
    expect(await introspect(db, "not-a-real-token")).toEqual({ active: false })
  })

  it("stops reporting a revoked access token as active", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const tokens = await exchangeAuthorizationCode(db, {
      code: await issueCode(fixture),
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })

    expect((await introspect(db, tokens.accessToken)).active).toBe(true)
    await revokeToken(db, tokens.accessToken)
    expect((await introspect(db, tokens.accessToken)).active).toBe(false)

    // Revoking one access token is not signing out everywhere — RFC 7009, and what a client
    // signing out of a single device means.
    const rotated = await rotateRefreshToken(db, {
      refreshToken: tokens.refreshToken,
      oauthClientId: fixture.clientId,
    })
    expect((await introspect(db, rotated.accessToken)).active).toBe(true)
  })

  it("revoking a refresh token takes the family with it", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const tokens = await exchangeAuthorizationCode(db, {
      code: await issueCode(fixture),
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })

    await revokeToken(db, tokens.refreshToken)

    // The point of revoking is that the credential stops working, and a family member left alive
    // is the credential still working.
    expect((await introspect(db, tokens.accessToken)).active).toBe(false)
    await expect(
      rotateRefreshToken(db, {
        refreshToken: tokens.refreshToken,
        oauthClientId: fixture.clientId,
      }),
    ).rejects.toThrow(/revoked/)
  })

  it("tells a resource server who the token is for", async ({ skip }) => {
    if (!reachable) skip()
    const fixture = await grant()
    const tokens = await exchangeAuthorizationCode(db, {
      code: await issueCode(fixture),
      oauthClientId: fixture.clientId,
      redirectUri: "https://app.example.com/callback",
      codeVerifier: VERIFIER,
    })

    const introspected = await introspect(db, tokens.accessToken)
    expect(introspected.userId).toBe(fixture.userId)
    expect(introspected.organizationId).toBe(fixture.organizationId)
    expect(introspected.scopes).toEqual(["project:read"])
  })
})
