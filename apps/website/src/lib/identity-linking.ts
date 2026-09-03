import {
  crudAccount,
  crudAuditLog,
  crudOauthIdentityFlow,
  crudUser,
  fetchAccount,
  authUser,
} from "@lib/dao"
import { openOauthIdentityVerifier, seal } from "@lib/envelope"
import type { OAuth2Tokens } from "@lib/oauth"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import { getCurrentSession } from "./auth"

export type IdentityProvider = "google" | "github"

export type ConsumedIdentityFlow = {
  id: string
  userId: string
  sessionKey: string
  provider: string
  intent: string
  targetAccountId: string | null
  returnTo: string
  verifier: string
}

export async function consumeIdentityFlow(state: string): Promise<ConsumedIdentityFlow | null> {
  const current = await getCurrentSession()
  if (current === null) return null
  const row = await crudOauthIdentityFlow(db).consume(
    encodeHexLowerCase(await sha256Utf8(state)),
    current.session.sessionKey,
  )
  if (row === undefined || row.userId !== current.user.id) return null
  const verifier = await openOauthIdentityVerifier(row.id, row.userId, {
    ciphertext: row.pkceCiphertext,
    wrappedDek: row.pkceWrappedDek,
    kmsKeyId: row.pkceKmsKeyId,
  })
  return {
    id: row.id,
    userId: row.userId,
    sessionKey: row.sessionKey,
    provider: row.provider,
    intent: row.intent,
    targetAccountId: row.targetAccountId,
    returnTo: row.returnTo,
    verifier,
  }
}

function redirectWithResult(returnTo: string, result: "linked" | "reauthorized" | "conflict") {
  const url = new URL(returnTo, "https://sproutos.invalid")
  url.searchParams.set("sign_in_method", result)
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.pathname}${url.search}${url.hash}` },
  })
}

async function recordIdentityConflict(input: {
  flow: ConsumedIdentityFlow
  provider: IdentityProvider
  request: Request
}) {
  await crudAuditLog(db).record({
    organizationId: null,
    actorUserId: input.flow.userId,
    action: "security:sign-in-method:conflict",
    resourceSrn: `srn:sproutos:iam::user/${input.flow.userId}`,
    after: { provider: input.provider, intent: input.flow.intent },
    ip: input.request.headers.get("x-forwarded-for"),
    userAgent: input.request.headers.get("user-agent"),
  })
}

export async function completeIdentityFlow(input: {
  flow: ConsumedIdentityFlow
  provider: IdentityProvider
  providerAccountId: string
  displayIdentity: string
  githubLogin?: string
  tokens: OAuth2Tokens
  request: Request
}): Promise<Response> {
  if (input.flow.provider !== input.provider) return new Response(null, { status: 400 })

  const [identityOwner, target] = await Promise.all([
    fetchAccount(db).findByProviderIdentity(input.provider, input.providerAccountId, [
      "id",
      "userId",
    ]),
    input.flow.targetAccountId === null
      ? Promise.resolve(undefined)
      : fetchAccount(db).getForUser(input.flow.userId, input.flow.targetAccountId, [
          "id",
          "providerAccountId",
          "provider",
        ]),
  ])

  const targetMismatch =
    input.flow.intent === "reauthorize" &&
    (target === undefined ||
      target.provider !== input.provider ||
      target.providerAccountId !== input.providerAccountId)
  if (
    targetMismatch ||
    (identityOwner !== undefined && identityOwner.userId !== input.flow.userId)
  ) {
    await recordIdentityConflict(input)
    return redirectWithResult(input.flow.returnTo, "conflict")
  }

  const accountId = target?.id ?? identityOwner?.id
  const access = await seal(input.tokens.accessToken, {
    userId: input.flow.userId,
    provider: input.provider,
    field: "access_token",
  })
  const refresh =
    input.tokens.refreshToken === null
      ? null
      : await seal(input.tokens.refreshToken, {
          userId: input.flow.userId,
          provider: input.provider,
          field: "refresh_token",
        })

  try {
    await db.transaction().execute(async (tx) => {
      const values = {
        userId: input.flow.userId,
        type: input.provider === "google" ? "oidc" : "oauth",
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        displayIdentity: input.displayIdentity,
        accessTokenCiphertext: access.ciphertext,
        accessTokenWrappedDek: access.wrappedDek,
        accessTokenKmsKeyId: access.kmsKeyId,
        ...(refresh === null
          ? {
              refreshTokenCiphertext: null,
              refreshTokenWrappedDek: null,
              refreshTokenKmsKeyId: null,
              refreshTokenExpiresAt: null,
            }
          : {
              refreshTokenCiphertext: refresh.ciphertext,
              refreshTokenWrappedDek: refresh.wrappedDek,
              refreshTokenKmsKeyId: refresh.kmsKeyId,
              refreshTokenExpiresAt: null,
            }),
        scopes: [...input.tokens.scopes],
        tokenType: input.tokens.tokenType,
        accessTokenExpiresAt:
          input.tokens.accessTokenExpiresInSeconds === null
            ? null
            : new Date(Date.now() + input.tokens.accessTokenExpiresInSeconds * 1000),
      }
      const account =
        accountId === undefined
          ? await crudAccount(tx).createAccount(values)
          : await crudAccount(tx).updateAccount(accountId, input.flow.userId, values)
      if (account === undefined) {
        throw new Error("Sign-in method disappeared during authorization")
      }

      if (input.provider === "github") {
        await crudUser(tx).updateGithubIdentity(input.flow.userId, {
          githubLogin: input.githubLogin ?? input.displayIdentity,
          githubUserId: BigInt(input.providerAccountId),
        })
      }
      if (!(await authUser(tx).markReauthenticated(input.flow.sessionKey, input.flow.userId))) {
        throw new Error("The linking session is no longer active")
      }
      await crudAuditLog(tx).record({
        organizationId: null,
        actorUserId: input.flow.userId,
        action: `security:sign-in-method:${accountId === undefined ? "link" : "reauthorize"}`,
        resourceSrn: `srn:sproutos:iam::account/${account.id}`,
        after: { provider: input.provider, displayIdentity: input.displayIdentity },
        ip: input.request.headers.get("x-forwarded-for"),
        userAgent: input.request.headers.get("user-agent"),
      })
    })
  } catch (error) {
    // The provider identity is globally unique. A concurrent callback can win after the read above;
    // that is still a safe conflict, never a reason to expose a database error or merge users.
    if ((error as { code?: unknown }).code !== "23505") throw error
    await recordIdentityConflict(input)
    return redirectWithResult(input.flow.returnTo, "conflict")
  }

  return redirectWithResult(
    input.flow.returnTo,
    accountId === undefined ? "linked" : "reauthorized",
  )
}
