import type { DB } from "@sproutos/db"
import { encodeHexLowerCase, generateUrlSafeToken, sha256Utf8 } from "@utils/crypto"
import { type Kysely, sql, type Transaction } from "kysely"
import { v7 } from "uuid"
import { OAuthError } from "./errors"
import { verifyPkce } from "./pkce"

/**
 * Access and refresh tokens are **opaque and stored as hashes**, not JWTs.
 *
 * The schema says so — `oauth_access_token.token_hash` is the primary key — and it is the right
 * shape for this product. A JWT cannot be revoked before it expires without a revocation list,
 * which is a database lookup wearing a hat; if every check hits the database anyway, the
 * self-contained token buys nothing and costs the ability to revoke.
 *
 * Only the hash is stored, exactly as sessions do it, so a database leak yields nothing
 * replayable.
 */

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60
const AUTHORIZATION_CODE_TTL_SECONDS = 60

export type IssuedTokens = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: string[]
}

export async function hashToken(token: string): Promise<string> {
  return encodeHexLowerCase(await sha256Utf8(token))
}

/** Issued to the browser and never stored in the clear. */
export function generateOpaqueToken(): string {
  return generateUrlSafeToken(32)
}

export type CreateAuthorizationCode = {
  oauthClientId: string
  userId: string
  organizationId: string
  oauthGrantId: string
  redirectUri: string
  scopes: readonly string[]
  codeChallenge: string
  nonce?: string | null
}

/**
 * Mint an authorization code.
 *
 * Short-lived by design — sixty seconds is long enough for a browser redirect and a token call,
 * and far too short for a code sitting in someone's shell history or a proxy log to be worth
 * anything.
 */
export async function createAuthorizationCode(
  db: Kysely<DB>,
  input: CreateAuthorizationCode,
): Promise<string> {
  const code = generateOpaqueToken()

  await db
    .insertInto("oauthAuthorizationCode")
    .values({
      codeHash: await hashToken(code),
      oauthClientId: input.oauthClientId,
      userId: input.userId,
      organizationId: input.organizationId,
      oauthGrantId: input.oauthGrantId,
      redirectUri: input.redirectUri,
      scopes: [...input.scopes],
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      nonce: input.nonce ?? null,
      expiresAt: sql<Date>`now() + make_interval(secs => ${AUTHORIZATION_CODE_TTL_SECONDS})`,
    })
    .execute()

  return code
}

export type ExchangeCode = {
  code: string
  oauthClientId: string
  redirectUri: string
  codeVerifier: string
}

/**
 * Exchange an authorization code for tokens. Single use, enforced by the database.
 *
 * The consumption is an UPDATE with `consumed_at is null` in its WHERE clause, so two simultaneous
 * exchanges of the same code race in Postgres and exactly one wins. Reading, checking, then
 * writing would let both through — and a replayed code is precisely what an attacker who
 * intercepted the redirect has.
 *
 * Every check is inside the same transaction as the consumption, so a code that fails PKCE is
 * still burned. Leaving it alive would turn a failed verifier into a free retry.
 */
export async function exchangeAuthorizationCode(
  db: Kysely<DB>,
  input: ExchangeCode,
): Promise<IssuedTokens> {
  const codeHash = await hashToken(input.code)

  /*
    Consumed in its own committed statement, *before* anything is validated.

    The obvious structure — consume and validate inside one transaction — is wrong, and the tests
    caught it: throwing on a failed PKCE check rolls the transaction back, including the
    consumption, so the code stays alive. An attacker holding a stolen code could then grind at
    `code_verifier` until something worked, which is the exact attack PKCE exists to stop.

    So the code is burned first and unconditionally. A legitimate client that fails validation has
    to restart the authorization flow, which is the right outcome for a request that did not prove
    possession of the verifier.
  */
  const consumed = await db
    .updateTable("oauthAuthorizationCode")
    .set({ consumedAt: new Date() })
    .where("codeHash", "=", codeHash)
    .where("consumedAt", "is", null)
    .where("expiresAt", ">", sql<Date>`now()`)
    .returningAll()
    .executeTakeFirst()

  // One error for "no such code", "already used", and "expired". Distinguishing them tells an
  // attacker holding a stolen code whether it was ever real.
  if (consumed === undefined) {
    throw new OAuthError("invalid_grant", "The authorization code is invalid or has expired")
  }

  if (consumed.oauthClientId !== input.oauthClientId) {
    throw new OAuthError("invalid_grant", "The authorization code was issued to another client")
  }
  // Exact match again at redemption, not only at authorization: a code obtained through an open
  // redirect on a *different* registered URI must not be redeemable against this one.
  if (consumed.redirectUri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request")
  }
  if (!(await verifyPkce(input.codeVerifier, consumed.codeChallenge))) {
    throw new OAuthError("invalid_grant", "code_verifier does not match the challenge")
  }

  return await db.transaction().execute(
    async (tx) =>
      await issueTokens(tx, {
        oauthGrantId: consumed.oauthGrantId,
        oauthClientId: consumed.oauthClientId,
        userId: consumed.userId,
        scopes: consumed.scopes,
        familyId: v7(),
        parentTokenHash: null,
      }),
  )
}

export async function rotateRefreshToken(
  db: Kysely<DB>,
  input: { refreshToken: string; oauthClientId: string; scopes?: readonly string[] },
): Promise<IssuedTokens> {
  const tokenHash = await hashToken(input.refreshToken)

  const outcome = await db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("oauthRefreshToken")
      .innerJoin("oauthGrant", "oauthGrant.id", "oauthRefreshToken.oauthGrantId")
      .select([
        "oauthRefreshToken.oauthGrantId as oauthGrantId",
        "oauthRefreshToken.familyId as familyId",
        "oauthRefreshToken.consumedAt as consumedAt",
        "oauthRefreshToken.revokedAt as revokedAt",
        "oauthRefreshToken.expiresAt as expiresAt",
        "oauthGrant.oauthClientId as oauthClientId",
        "oauthGrant.userId as userId",
        "oauthGrant.scopes as grantScopes",
        "oauthGrant.revokedAt as grantRevokedAt",
      ])
      .where("oauthRefreshToken.tokenHash", "=", tokenHash)
      .forUpdate()
      .executeTakeFirst()

    if (existing === undefined) return { kind: "invalid" as const }

    /*
      Reuse is *returned*, not thrown.

      Revoking the family and then throwing from inside the transaction would roll the revocation
      back — the tests caught exactly that — leaving the stolen token working and the theft
      undetected. So the detection commits and the caller raises afterwards.
    */
    if (existing.consumedAt !== null) {
      return { kind: "reused" as const, familyId: existing.familyId }
    }

    if (existing.revokedAt !== null || existing.grantRevokedAt !== null) {
      return { kind: "revoked" as const }
    }
    if (existing.expiresAt.getTime() <= Date.now()) return { kind: "expired" as const }
    if (existing.oauthClientId !== input.oauthClientId) return { kind: "wrong_client" as const }

    // A refresh may narrow scope but never widen it — RFC 6749 §6. Otherwise a token granted
    // `project:read` could refresh itself into `project:delete`. Thrown rather than returned:
    // nothing has been written yet, so rolling back costs nothing.
    const scopes = narrowScopes(existing.grantScopes, input.scopes)

    await tx
      .updateTable("oauthRefreshToken")
      .set({ consumedAt: new Date() })
      .where("tokenHash", "=", tokenHash)
      .execute()

    return {
      kind: "rotated" as const,
      tokens: await issueTokens(tx, {
        oauthGrantId: existing.oauthGrantId,
        oauthClientId: existing.oauthClientId,
        userId: existing.userId,
        scopes,
        familyId: existing.familyId,
        parentTokenHash: tokenHash,
      }),
    }
  })

  switch (outcome.kind) {
    case "rotated":
      return outcome.tokens
    case "reused":
      // Its own transaction, so the revocation survives the error that follows it.
      await db.transaction().execute(async (tx) => {
        await revokeFamily(tx, outcome.familyId)
      })
      throw new OAuthError(
        "invalid_grant",
        "This refresh token has already been used. All tokens in the family have been revoked.",
      )
    case "revoked":
      throw new OAuthError("invalid_grant", "The refresh token has been revoked")
    case "expired":
      throw new OAuthError("invalid_grant", "The refresh token has expired")
    case "wrong_client":
      throw new OAuthError("invalid_grant", "The refresh token was issued to another client")
    default:
      throw new OAuthError("invalid_grant", "The refresh token is invalid")
  }
}

export function narrowScopes(
  granted: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  if (requested === undefined || requested.length === 0) return [...granted]

  const widened = requested.filter((scope) => !granted.includes(scope))
  if (widened.length > 0) {
    throw new OAuthError("invalid_scope", `Not granted: ${widened.join(", ")}`)
  }
  return [...requested]
}

async function issueTokens(
  tx: Transaction<DB>,
  input: {
    oauthGrantId: string
    oauthClientId: string
    userId: string
    scopes: readonly string[]
    familyId: string
    parentTokenHash: string | null
  },
): Promise<IssuedTokens> {
  const accessToken = generateOpaqueToken()
  const refreshToken = generateOpaqueToken()

  await tx
    .insertInto("oauthAccessToken")
    .values({
      tokenHash: await hashToken(accessToken),
      oauthGrantId: input.oauthGrantId,
      oauthClientId: input.oauthClientId,
      userId: input.userId,
      scopes: [...input.scopes],
      expiresAt: sql<Date>`now() + make_interval(secs => ${ACCESS_TOKEN_TTL_SECONDS})`,
    })
    .execute()

  await tx
    .insertInto("oauthRefreshToken")
    .values({
      tokenHash: await hashToken(refreshToken),
      oauthGrantId: input.oauthGrantId,
      familyId: input.familyId,
      parentTokenHash: input.parentTokenHash,
      expiresAt: sql<Date>`now() + make_interval(secs => ${REFRESH_TOKEN_TTL_SECONDS})`,
    })
    .execute()

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scopes: [...input.scopes],
  }
}

/**
 * Revoke every token descended from one authorization.
 *
 * Access tokens are revoked too, not only refresh tokens: leaving a live access token behind gives
 * an attacker up to an hour after detection, which is most of what they wanted anyway.
 */
async function revokeFamily(tx: Transaction<DB>, familyId: string): Promise<void> {
  const now = new Date()

  await tx
    .updateTable("oauthRefreshToken")
    .set({ revokedAt: now })
    .where("familyId", "=", familyId)
    .where("revokedAt", "is", null)
    .execute()

  await tx
    .updateTable("oauthAccessToken")
    .set({ revokedAt: now })
    .where((eb) =>
      eb(
        "oauthGrantId",
        "in",
        eb.selectFrom("oauthRefreshToken").select("oauthGrantId").where("familyId", "=", familyId),
      ),
    )
    .where("revokedAt", "is", null)
    .execute()
}

/** What a resource server gets when it presents a bearer token. */
export type IntrospectedToken = {
  active: boolean
  userId?: string
  oauthClientId?: string
  /**
   * The grant this token was issued under.
   *
   * Carried so that anything the token creates can be attributed to it — a database provisioned by
   * an application belongs to that application's grant, and revoking the grant must be able to find
   * the credential it minted. Without this the application and the user hold the same secret and
   * neither can be revoked without the other.
   */
  oauthGrantId?: string
  organizationId?: string
  scopes?: string[]
  expiresAt?: Date
}

export async function introspect(db: Kysely<DB>, token: string): Promise<IntrospectedToken> {
  const row = await db
    .selectFrom("oauthAccessToken")
    .innerJoin("oauthGrant", "oauthGrant.id", "oauthAccessToken.oauthGrantId")
    .select([
      "oauthAccessToken.userId as userId",
      "oauthAccessToken.oauthClientId as oauthClientId",
      "oauthAccessToken.scopes as scopes",
      "oauthAccessToken.expiresAt as expiresAt",
      "oauthAccessToken.revokedAt as revokedAt",
      "oauthAccessToken.oauthGrantId as oauthGrantId",
      "oauthGrant.organizationId as organizationId",
      "oauthGrant.revokedAt as grantRevokedAt",
    ])
    .where("oauthAccessToken.tokenHash", "=", await hashToken(token))
    .executeTakeFirst()

  if (row === undefined) return { active: false }
  if (row.revokedAt !== null || row.grantRevokedAt !== null) return { active: false }
  if (row.expiresAt.getTime() <= Date.now()) return { active: false }

  return {
    active: true,
    userId: row.userId,
    oauthClientId: row.oauthClientId,
    oauthGrantId: row.oauthGrantId,
    organizationId: row.organizationId,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
  }
}

/**
 * RFC 7009 revocation.
 *
 * Revoking a refresh token takes its whole family with it, because the point of revoking is that
 * the credential stops working — and a family member left alive is the credential still working.
 * Revoking an access token takes only that token, which is what the RFC says and what a client
 * signing out of one device means.
 */
export async function revokeToken(db: Kysely<DB>, token: string): Promise<void> {
  const tokenHash = await hashToken(token)

  await db.transaction().execute(async (tx) => {
    const refresh = await tx
      .selectFrom("oauthRefreshToken")
      .select("familyId")
      .where("tokenHash", "=", tokenHash)
      .executeTakeFirst()

    if (refresh !== undefined) {
      await revokeFamily(tx, refresh.familyId)
      return
    }

    await tx
      .updateTable("oauthAccessToken")
      .set({ revokedAt: new Date() })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .execute()
  })
}
