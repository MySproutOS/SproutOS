import { crudAccount } from "@lib/dao/account/crud"
import { crudUser } from "@lib/dao/user/crud"
import { type OAuth2Tokens, parseGoogleIdToken } from "@lib/oauth"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { createSession, generateSessionToken, setSessionTokenCookie } from "@website/lib/auth"
import { googleOAuthClient } from "@website/lib/oauth"
import { cookies } from "next/headers"

function badRequest(): Response {
  return new Response(null, { status: 400 })
}

function redirectHome(): Response {
  return new Response(null, { status: 302, headers: { Location: "/" } })
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  const cookieStore = await cookies()
  const storedState = cookieStore.get("google_oauth_state")?.value ?? null
  const codeVerifier = cookieStore.get("google_code_verifier")?.value ?? null
  // Single-use: clear them whether or not the rest of the flow succeeds.
  cookieStore.delete("google_oauth_state")
  cookieStore.delete("google_code_verifier")

  if (code === null || state === null || storedState === null || codeVerifier === null) {
    return badRequest()
  }
  if (!constantTimeEqualUtf8(state, storedState)) {
    return badRequest()
  }

  let tokens: OAuth2Tokens
  try {
    tokens = await googleOAuthClient().validateAuthorizationCode(code, codeVerifier)
  } catch {
    // Invalid or replayed code, or bad client credentials.
    return badRequest()
  }

  if (tokens.idToken === null) {
    // Only happens if the `openid` scope was dropped from the authorization request.
    return badRequest()
  }

  let claims: ReturnType<typeof parseGoogleIdToken>
  try {
    claims = parseGoogleIdToken(tokens.idToken)
  } catch {
    return badRequest()
  }

  // Key on `sub`: it is Google's stable account identifier, whereas an email address can change
  // hands. An unverified address must never be enough to claim an existing account.
  if (!claims.emailVerified) {
    return badRequest()
  }

  const existingAccount = await db
    .selectFrom("account")
    .where("providerAccountId", "=", claims.sub)
    .where("provider", "=", "google")
    .select("userId")
    .executeTakeFirst()

  if (existingAccount) {
    const sessionToken = generateSessionToken()
    const session = await createSession(sessionToken, existingAccount.userId)
    await setSessionTokenCookie(sessionToken, session.expires)
    return redirectHome()
  }

  let user = await db
    .selectFrom("user")
    .where("email", "=", claims.email)
    .selectAll()
    .executeTakeFirst()
  user ??= await crudUser(db).createUser({
    name: claims.name,
    email: claims.email,
    image: claims.picture,
  })

  await crudAccount(db).createAccount({
    userId: user.id,
    provider: "google",
    providerAccountId: claims.sub,
    type: "oauth",
    scope: tokens.scopes.join(" "),
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    expiresAt: claims.exp,
  })

  const sessionToken = generateSessionToken()
  const session = await createSession(sessionToken, user.id)
  await setSessionTokenCookie(sessionToken, session.expires)
  return redirectHome()
}
