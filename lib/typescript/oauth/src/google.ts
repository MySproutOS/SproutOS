import { OAuth2Client } from "./client"
import { OAuth2ResponseError } from "./errors"
import { decodeJwtPayload } from "./jwt"

const GOOGLE_ENDPOINTS = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
} as const

/** The scopes we ask Google for: identity plus basic profile. */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const

/** Build the Google client from the environment.
 *
 *  A function rather than a module-level constant so the values are read after the process has
 *  loaded its `.env`, and so a missing variable fails at the point of use with a clear message
 *  instead of a non-null assertion swallowing it. */
export function googleOAuthClient(): OAuth2Client {
  return new OAuth2Client({
    /*
      `GOOGLE_OAUTH_CLIENT_ID`, not `GOOGLE_CLIENT_ID`.

      The vendored client read the shorter names and nothing ever called it, so the mismatch with
      the names actually configured survived until the first caller was written. It would have
      failed at the point of use with "Missing required environment variable: GOOGLE_CLIENT_ID"
      while the value sat in `.env` under a different name — a confusing five minutes for the sake
      of two words.
    */
    clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: `${requireEnv("NEXT_PUBLIC_HOST_URL")}/login/google/callback`,
    endpoints: GOOGLE_ENDPOINTS,
  })
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/** The ID token claims we rely on, after validation.
 *
 *  Google documents many more; this is the subset we read. `sub` is the stable account
 *  identifier — the one to key the `account` table on, since email addresses change. */
export interface GoogleIdTokenClaims {
  readonly sub: string
  readonly email: string
  readonly emailVerified: boolean
  readonly name: string | null
  readonly picture: string | null
  /** Expiry as a Unix timestamp in seconds. */
  readonly exp: number
}

/** Decode and validate a Google ID token's claims.
 *
 *  The signature is not verified; see the note on `decodeJwtPayload` for why that is sound for a
 *  token read straight out of a token response. */
export function parseGoogleIdToken(idToken: string): GoogleIdTokenClaims {
  const claims = decodeJwtPayload(idToken)

  const sub = claims.sub
  const email = claims.email
  const exp = claims.exp
  if (typeof sub !== "string" || sub === "") {
    throw new OAuth2ResponseError("Google ID token is missing 'sub'")
  }
  if (typeof email !== "string" || email === "") {
    throw new OAuth2ResponseError("Google ID token is missing 'email'")
  }
  if (typeof exp !== "number") {
    throw new OAuth2ResponseError("Google ID token is missing 'exp'")
  }

  return {
    sub,
    email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    exp,
  }
}
