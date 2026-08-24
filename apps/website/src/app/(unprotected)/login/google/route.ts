import { cookieDomain } from "@website/lib/auth"
import {
  GOOGLE_SCOPES,
  generateCodeVerifier,
  generateState,
  googleOAuthClient,
} from "@website/lib/oauth"
import { RETURN_TO_COOKIE, sanitizeReturnTo } from "@website/lib/return-to"
import { cookies } from "next/headers"

/**
 * Sign in with Google.
 *
 * The shape mirrors `/login/github` deliberately — same transient cookies, same `?next=` handling,
 * same `Domain` scoping — because the two flows differ in exactly one interesting way and every
 * other difference would be an accident waiting to be debugged twice.
 *
 * **The one real difference: PKCE is not decoration here.** GitHub's web flow ignores
 * `code_challenge`, so the verifier we send it is discarded and `state` is the only CSRF defence —
 * `lib/typescript/oauth`'s GitHub notes say so. Google implements PKCE properly, so the verifier
 * below actually binds the authorization code to this browser. Same code path, materially stronger
 * guarantee, and worth knowing which is which before anyone "simplifies" one to match the other.
 */
function transientCookie() {
  return {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    sameSite: "lax",
    // Domain-scoped for the reason the GitHub route documents at length: a sign-in that begins on
    // the apex finishes on the app host, and a host-only cookie is not sent to the second.
    domain: cookieDomain(),
  } as const
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const returnTo = sanitizeReturnTo(params.get("next"))

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await googleOAuthClient().createAuthorizationUrl(state, codeVerifier, [
    ...GOOGLE_SCOPES,
  ])

  const cookieStore = await cookies()
  const transient = transientCookie()
  cookieStore.set("google_oauth_state", state, transient)
  cookieStore.set("google_code_verifier", codeVerifier, transient)
  if (returnTo !== null) cookieStore.set(RETURN_TO_COOKIE, returnTo, transient)

  return new Response(null, { status: 302, headers: { Location: url.toString() } })
}
