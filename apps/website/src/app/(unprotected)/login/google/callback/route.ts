import { crudAccount } from "@lib/dao/account/crud"
import { provisionOrganization } from "@lib/dao/organization/provision"
import { crudUser } from "@lib/dao/user/crud"
import { seal } from "@lib/envelope"
import type { OAuth2Tokens } from "@lib/oauth"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import {
  cookieDomain,
  createSession,
  generateSessionToken,
  setSessionTokenCookie,
} from "@website/lib/auth"
import { googleOAuthClient, parseGoogleIdToken } from "@website/lib/oauth"
import { RETURN_TO_COOKIE, sanitizeReturnTo } from "@website/lib/return-to"
import { mayLinkByEmail } from "@website/lib/account-linking"
import { completeIdentityFlow, consumeIdentityFlow } from "@website/lib/identity-linking"
import { cookies } from "next/headers"

const PROVIDER = "google"

function badRequest(reason: string): Response {
  // The reason reaches the operator and never the browser, for the reasons the GitHub callback
  // gives: which half of the check failed is free information to an attacker, and a person landing
  // here can only retry either way.
  console.error(`google oauth callback refused: ${reason}`)
  return new Response(null, { status: 400 })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  const cookieStore = await cookies()
  // Deleted with the same `Domain` they were set with; a `delete` that omits it clears a host-only
  // cookie of that name and leaves the domain-scoped one behind.
  const transientScope = { path: "/", domain: cookieDomain() } as const
  const storedState = cookieStore.get("google_oauth_state")?.value ?? null
  const cookieVerifier = cookieStore.get("google_code_verifier")?.value ?? null
  const returnTo = sanitizeReturnTo(cookieStore.get(RETURN_TO_COOKIE)?.value ?? null)
  cookieStore.delete({ name: "google_oauth_state", ...transientScope })
  cookieStore.delete({ name: "google_code_verifier", ...transientScope })
  cookieStore.delete({ name: RETURN_TO_COOKIE, ...transientScope })

  if (code === null || state === null) {
    return badRequest(`missing code=${code !== null} state=${state !== null}`)
  }
  const identityFlow = await consumeIdentityFlow(state)
  const codeVerifier = identityFlow?.verifier ?? cookieVerifier
  if (codeVerifier === null) return badRequest("missing PKCE verifier")
  if (
    identityFlow === null &&
    (storedState === null || !constantTimeEqualUtf8(state, storedState))
  ) {
    return badRequest("state did not match the cookie")
  }

  let tokens: OAuth2Tokens
  try {
    tokens = await googleOAuthClient().validateAuthorizationCode(code, codeVerifier)
  } catch (cause) {
    return badRequest(`authorization code exchange failed: ${String(cause)}`)
  }

  /*
    Google's identity arrives in the ID token, not from a profile endpoint.

    `idToken` is the whole point of asking for the `openid` scope. Its absence is not a user error
    to retry — it means the scopes or the client are misconfigured — so it is logged as such.
  */
  if (tokens.idToken === undefined || tokens.idToken === null) {
    return badRequest("the token response carried no id_token; check the openid scope")
  }

  let claims: ReturnType<typeof parseGoogleIdToken>
  try {
    claims = parseGoogleIdToken(tokens.idToken)
  } catch (cause) {
    return badRequest(`unreadable id_token: ${String(cause)}`)
  }

  if (identityFlow !== null) {
    return await completeIdentityFlow({
      flow: identityFlow,
      provider: PROVIDER,
      providerAccountId: claims.sub,
      displayIdentity: claims.email,
      tokens,
      request,
    })
  }

  const existingAccount = await db
    .selectFrom("account")
    .where("provider", "=", PROVIDER)
    // `sub`, not the email. Google's `sub` is stable for the life of the account; an email address
    // is not, and a Workspace address can be reassigned to a different person entirely.
    .where("providerAccountId", "=", claims.sub)
    .select(["id", "userId"])
    .executeTakeFirst()

  const userId = existingAccount ? existingAccount.userId : await resolveUserId(claims)

  const sealed = await seal(tokens.accessToken, {
    userId,
    provider: PROVIDER,
    field: "access_token",
  })

  const accountValues = {
    userId,
    type: "oauth",
    provider: PROVIDER,
    providerAccountId: claims.sub,
    displayIdentity: claims.email,
    accessTokenCiphertext: sealed.ciphertext,
    accessTokenWrappedDek: sealed.wrappedDek,
    accessTokenKmsKeyId: sealed.kmsKeyId,
    scopes: [...tokens.scopes],
    tokenType: tokens.tokenType,
    accessTokenExpiresAt: tokens.accessTokenExpiresInSeconds
      ? new Date(Date.now() + tokens.accessTokenExpiresInSeconds * 1000)
      : null,
    updatedAt: new Date(),
  }

  if (existingAccount) {
    await db
      .updateTable("account")
      .set(accountValues)
      .where("id", "=", existingAccount.id)
      .execute()
  } else {
    await crudAccount(db).createAccount(accountValues)
  }

  await provisionOrganization(db).ensureDefaultOrganization({
    userId,
    name: claims.name,
    email: claims.email,
    audit: {
      ip: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    },
  })

  const sessionToken = generateSessionToken()
  const session = await createSession(sessionToken, userId)
  await setSessionTokenCookie(sessionToken, session.expires)
  return new Response(null, { status: 302, headers: { Location: returnTo ?? "/dashboard" } })
}

/**
 * Find or create the user behind a Google identity.
 *
 * **Linking only on a verified email, and this is the part that matters.** Signing in with Google
 * and finding an existing SproutOS user with the same address means adopting that user's account —
 * their organizations, their projects, their credits. If the address were unverified, anyone could
 * create a Google account claiming somebody else's email and walk straight into it.
 *
 * Google reports `email_verified` in the ID token and it is false for some Workspace and federated
 * setups, so this is not a theoretical branch. An unverified address gets a **new** user instead of
 * a refusal: the person still gets in, they simply do not inherit an existing account, and the two
 * can be linked later from settings by someone who can prove they hold both.
 */
async function resolveUserId(claims: ReturnType<typeof parseGoogleIdToken>): Promise<string> {
  if (mayLinkByEmail(claims)) {
    const existing = await db
      .selectFrom("user")
      .where("email", "=", claims.email)
      .where("deletedAt", "is", null)
      .select("id")
      .executeTakeFirst()

    if (existing) return existing.id
  }

  const created = await crudUser(db).createUser({
    name: claims.name,
    email: claims.email,
    image: claims.picture,
  })
  return created.id
}
