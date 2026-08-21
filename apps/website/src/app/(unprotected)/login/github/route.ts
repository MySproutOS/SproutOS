import {
  GITHUB_IDENTITY_SCOPES,
  GITHUB_REPOSITORY_SCOPES,
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

/**
 * TASK 9's step-up re-authentication.
 *
 * `GITHUB_REPOSITORY_SCOPES` has existed since the OAuth module was written and **nothing ever
 * asked for it** — it was an exported constant with no caller, so a user could sign in, click
 * "Fork this app", and hit a token that GitHub had only ever granted `read:user` and `user:email`.
 * The comment beside it described a step-up that had no route.
 *
 * `?scopes=repository` is that route. Deliberately not the default: `repo` is unavoidably coarse —
 * GitHub has no finer-grained OAuth App scope — so asking at the front door would mean every
 * visitor grants blanket access to every private repository they can see in order to look at a
 * dashboard.
 *
 * Re-authenticating replaces the stored token and the granted scopes on the same `account` row, so
 * escalation is one row widening rather than a second credential to keep in step. The callback
 * already does that; see its note about `existingAccount`.
 */
const SCOPE_SETS = {
  identity: GITHUB_IDENTITY_SCOPES,
  repository: GITHUB_REPOSITORY_SCOPES,
} as const

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams

  // A store listing sends people here to fork an app. Landing them on an empty dashboard
  // afterwards loses the thing they clicked, so remember the page and come back to it.
  const returnTo = sanitizeReturnTo(params.get("next"))

  /*
    An unknown value falls back to identity rather than erroring. This is a redirect a customer
    lands on from a link, and refusing it would strand them on a blank error page — whereas the
    narrower grant simply fails again at the action they were trying to take, with a message that
    names what is missing.
  */
  const requested = params.get("scopes")
  const scopes = requested === "repository" ? SCOPE_SETS.repository : SCOPE_SETS.identity

  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = await githubOAuthClient().createAuthorizationUrl(state, codeVerifier, [...scopes])

  const cookieStore = await cookies()
  cookieStore.set("github_oauth_state", state, TRANSIENT_COOKIE)
  cookieStore.set("github_code_verifier", codeVerifier, TRANSIENT_COOKIE)
  if (returnTo !== null) cookieStore.set(RETURN_TO_COOKIE, returnTo, TRANSIENT_COOKIE)

  return new Response(null, { status: 302, headers: { Location: url.toString() } })
}
