import { encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"

/**
 * PKCE, and only S256.
 *
 * OAuth 2.1 removes the implicit grant and makes PKCE mandatory for *every* client, public and
 * confidential alike, because an authorization code intercepted on the redirect is useless without
 * the verifier. `plain` is not accepted: it is a challenge equal to the verifier, so anyone who
 * sees the challenge can produce the verifier, which is no protection at all. The database agrees
 * — `oauth_authorization_code_challenge_method_check` allows only `S256`.
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  // RFC 7636 §4.1: 43–128 characters of unreserved alphabet. A short verifier is brute-forceable,
  // so the length floor is part of the security property rather than input tidiness.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false

  const derived = encodeBase64UrlNoPadding(await sha256Utf8(verifier))
  return timingSafeEqual(derived, challenge)
}

/**
 * Compared in constant time.
 *
 * The challenge is public — it travelled in a query string — so this is belt and braces rather
 * than load-bearing. It costs nothing and removes the need to think about it again.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}
