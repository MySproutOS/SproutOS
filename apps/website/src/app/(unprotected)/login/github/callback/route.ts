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
import { fetchGitHubUser, githubOAuthClient } from "@website/lib/oauth"
import { completeIdentityFlow, consumeIdentityFlow } from "@website/lib/identity-linking"
import { RETURN_TO_COOKIE, sanitizeReturnTo } from "@website/lib/return-to"
import { cookies } from "next/headers"

const PROVIDER = "github"

/**
 * A refused callback, with the reason in the log.
 *
 * The reason never reaches the browser: telling an attacker which half of the check failed is free
 * information, and a person who lands here can only retry the sign-in anyway. It does reach the
 * operator, because it did not, and a 400 with no cause took a live cluster round-trip to explain
 * when the state cookie turned out to be scoped to the wrong host.
 */
function badRequest(reason: string): Response {
  console.error(`github oauth callback refused: ${reason}`)
  return new Response(null, { status: 400 })
}

function redirectAfterLogin(returnTo: string | null): Response {
  return new Response(null, { status: 302, headers: { Location: returnTo ?? "/dashboard" } })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  const cookieStore = await cookies()
  // Deleted with the same `Domain` they were set with. A `delete` that omits it clears a host-only
  // cookie of that name and leaves the domain-scoped one in place, which is the same class of bug
  // as setting it host-only in the first place.
  const transientScope = { path: "/", domain: cookieDomain() } as const
  const storedState = cookieStore.get("github_oauth_state")?.value ?? null
  const cookieVerifier = cookieStore.get("github_code_verifier")?.value ?? null
  // Re-sanitized on the way out as well as in: the cookie is httpOnly, but validating a
  // redirect target at exactly the point it becomes a Location header is worth the two lines.
  const returnTo = sanitizeReturnTo(cookieStore.get(RETURN_TO_COOKIE)?.value ?? null)
  // Single-use: clear them whether or not the rest of the flow succeeds.
  cookieStore.delete({ name: "github_oauth_state", ...transientScope })
  cookieStore.delete({ name: "github_code_verifier", ...transientScope })
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
    tokens = await githubOAuthClient().validateAuthorizationCode(code, codeVerifier)
  } catch (cause) {
    // Invalid or replayed code, or bad client credentials.
    return badRequest(`authorization code exchange failed: ${String(cause)}`)
  }

  let profile: Awaited<ReturnType<typeof fetchGitHubUser>>
  try {
    profile = await fetchGitHubUser(tokens.accessToken)
  } catch (cause) {
    return badRequest(`fetching the GitHub profile failed: ${String(cause)}`)
  }

  if (identityFlow !== null) {
    return await completeIdentityFlow({
      flow: identityFlow,
      provider: PROVIDER,
      providerAccountId: profile.id,
      displayIdentity: profile.login,
      githubLogin: profile.login,
      tokens,
      request,
    })
  }

  const existingAccount = await db
    .selectFrom("account")
    .where("provider", "=", PROVIDER)
    .where("providerAccountId", "=", profile.id)
    .select(["id", "userId"])
    .executeTakeFirst()

  const userId = existingAccount
    ? existingAccount.userId
    : await resolveUserId(profile.email, profile)

  // The access token is a credential for the user's repositories, so it is
  // sealed under the account row it belongs to. A ciphertext lifted into
  // another row will not open.
  const sealed = await seal(tokens.accessToken, {
    userId,
    provider: PROVIDER,
    field: "access_token",
  })

  const accountValues = {
    userId,
    type: "oauth",
    provider: PROVIDER,
    providerAccountId: profile.id,
    displayIdentity: profile.login,
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
    // Re-authentication replaces the stored token and the granted scopes, which
    // is how step-up escalation lands: the same account row, wider `scopes`.
    await db
      .updateTable("account")
      .set(accountValues)
      .where("id", "=", existingAccount.id)
      .execute()
  } else {
    await crudAccount(db).createAccount(accountValues)
  }
  await crudUser(db).updateGithubIdentity(userId, {
    githubLogin: profile.login,
    githubUserId: BigInt(profile.id),
  })

  // Every user belongs to an organization, so the first sign-in creates
  // "<Name>'s Team". Idempotent and cheap on every later sign-in — an existing
  // membership returns without writing — so it runs unconditionally rather than
  // only on the branch that created the user.
  await provisionOrganization(db).ensureDefaultOrganization({
    userId,
    name: profile.name,
    email: profile.email,
    audit: {
      ip: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    },
  })

  const sessionToken = generateSessionToken()
  const session = await createSession(sessionToken, userId)
  await setSessionTokenCookie(sessionToken, session.expires)
  return redirectAfterLogin(returnTo)
}

/**
 * Find or create the user behind a GitHub profile.
 *
 * Matching on a verified email lets someone who signed up another way keep one
 * account, but the GitHub numeric id is what the `account` row keys on — a login
 * can be renamed and then claimed by somebody else.
 */
async function resolveUserId(
  email: string,
  profile: Awaited<ReturnType<typeof fetchGitHubUser>>,
): Promise<string> {
  const existing = await db
    .selectFrom("user")
    .where("email", "=", email)
    .where("deletedAt", "is", null)
    .select("id")
    .executeTakeFirst()

  if (existing) return existing.id

  const created = await crudUser(db).createUser({
    name: profile.name,
    email,
    image: profile.avatarUrl,
    githubLogin: profile.login,
    githubUserId: BigInt(profile.id),
  })
  return created.id
}
