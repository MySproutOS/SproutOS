import { crudAccount } from "@lib/dao/account/crud"
import { provisionOrganization } from "@lib/dao/organization/provision"
import { crudUser } from "@lib/dao/user/crud"
import { seal } from "@lib/envelope"
import type { OAuth2Tokens } from "@lib/oauth"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { createSession, generateSessionToken, setSessionTokenCookie } from "@website/lib/auth"
import { fetchGitHubUser, githubOAuthClient } from "@website/lib/oauth"
import { cookies } from "next/headers"

const PROVIDER = "github"

function badRequest(): Response {
  return new Response(null, { status: 400 })
}

function redirectToDashboard(): Response {
  return new Response(null, { status: 302, headers: { Location: "/dashboard" } })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  const cookieStore = await cookies()
  const storedState = cookieStore.get("github_oauth_state")?.value ?? null
  const codeVerifier = cookieStore.get("github_code_verifier")?.value ?? null
  // Single-use: clear them whether or not the rest of the flow succeeds.
  cookieStore.delete("github_oauth_state")
  cookieStore.delete("github_code_verifier")

  if (code === null || state === null || storedState === null || codeVerifier === null) {
    return badRequest()
  }
  if (!constantTimeEqualUtf8(state, storedState)) {
    return badRequest()
  }

  let tokens: OAuth2Tokens
  try {
    tokens = await githubOAuthClient().validateAuthorizationCode(code, codeVerifier)
  } catch {
    // Invalid or replayed code, or bad client credentials.
    return badRequest()
  }

  let profile: Awaited<ReturnType<typeof fetchGitHubUser>>
  try {
    profile = await fetchGitHubUser(tokens.accessToken)
  } catch {
    return badRequest()
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
  return redirectToDashboard()
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
