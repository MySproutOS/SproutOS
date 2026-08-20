/** Cryptographically secure random values, via the platform CSPRNG. */

import { encodeBase32LowerCaseNoPadding, encodeBase64UrlNoPadding } from "./encoding"

/** `length` random bytes from the platform CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** A random session token: 20 bytes (160 bits) as lowercase base32, so 32 URL-safe characters.
 *
 *  Store the SHA-256 of this, never the token itself — a leaked database then yields nothing
 *  that can be replayed as a cookie. */
export function generateSessionToken(): string {
  return encodeBase32LowerCaseNoPadding(randomBytes(20))
}

/** A random URL-safe token of `byteLength` bytes, used for OAuth state and PKCE verifiers. */
export function generateUrlSafeToken(byteLength = 32): string {
  return encodeBase64UrlNoPadding(randomBytes(byteLength))
}
