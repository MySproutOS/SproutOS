import {
  GITHUB_IDENTITY_SCOPES,
  generateCodeVerifier,
  generateState,
  githubOAuthClient,
} from "@website/lib/oauth"
import { RETURN_TO_COOKIE, sanitizeReturnTo } from "@website/lib/return-to"
import { cookies } from "next/headers"

/** State and PKCE verifier live in short-lived httpOnly cookies: the callback compares them to
 *  prove the redirect belongs to a flow this browser actually started. */
const TRANSIENT_COOKIE = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 10,
  sameSite: "lax",
} as const

export async function GET(request: Request) {
  // A store listing sends people here to fork an app. Landing them on an empty dashboard
  // afterwards loses the thing they clicked, so remember the page and come back to it.
  const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("next"))

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await githubOAuthClient().createAuthorizationUrl(state, codeVerifier, [
    ...GITHUB_IDENTITY_SCOPES,
  ])

  const cookieStore = await cookies()
  cookieStore.set("github_oauth_state", state, TRANSIENT_COOKIE)
  cookieStore.set("github_code_verifier", codeVerifier, TRANSIENT_COOKIE)
  if (returnTo !== null) cookieStore.set(RETURN_TO_COOKIE, returnTo, TRANSIENT_COOKIE)

  return new Response(null, { status: 302, headers: { Location: url.toString() } })
}
