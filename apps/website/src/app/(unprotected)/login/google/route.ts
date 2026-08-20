import {
  GOOGLE_SCOPES,
  generateCodeVerifier,
  generateState,
  googleOAuthClient,
} from "@website/lib/oauth"
import { cookies } from "next/headers"

/** State and PKCE verifier live in short-lived httpOnly cookies: the callback compares them to
 *  prove the redirect belongs to a flow this browser actually started. */
const TRANSIENT_COOKIE = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 10, // 10 minutes
  sameSite: "lax",
} as const

export async function GET() {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await googleOAuthClient().createAuthorizationUrl(state, codeVerifier, GOOGLE_SCOPES)

  const cookieStore = await cookies()
  cookieStore.set("google_oauth_state", state, TRANSIENT_COOKIE)
  cookieStore.set("google_code_verifier", codeVerifier, TRANSIENT_COOKIE)

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
    },
  })
}
