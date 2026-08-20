/** Binary-to-text encodings.
 *
 *  Hand-rolled rather than pulled from a dependency: each is a dozen lines, has a frozen spec
 *  (RFC 4648) and no platform primitive that works uniformly across Node, edge runtimes and the
 *  browser. `Buffer` would cover Node only, and the session cookie is read from the Next.js
 *  proxy, which may run on the edge.
 *
 *  Mostly encode-only: the one decoder is base64url, needed to read a JWT payload. */

const BASE32_LOWERCASE = "abcdefghijklmnopqrstuvwxyz234567"
const BASE64_STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Lowercase hex, two characters per byte. Used for session keys, which are stored as text. */
export function encodeHexLowerCase(bytes: Uint8Array): string {
  let result = ""
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0")
  }
  return result
}

/** RFC 4648 base32 in lowercase with no `=` padding.
 *
 *  Used for session tokens because base32 is case-insensitive and free of characters that need
 *  escaping in a cookie value or URL. */
export function encodeBase32LowerCaseNoPadding(bytes: Uint8Array): string {
  let result = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    // At most 4 bits are ever left over, so `buffer` holds 12 bits at peak — no overflow.
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_LOWERCASE[(buffer >> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    result += BASE32_LOWERCASE[(buffer << (5 - bits)) & 0x1f]
  }
  return result
}

function encodeBase64With(bytes: Uint8Array, alphabet: string, padded: boolean): string {
  let result = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i
    const chunk =
      (bytes[i] << 16) |
      ((remaining > 1 ? bytes[i + 1] : 0) << 8) |
      (remaining > 2 ? bytes[i + 2] : 0)

    result += alphabet[(chunk >> 18) & 0x3f]
    result += alphabet[(chunk >> 12) & 0x3f]
    result += remaining > 1 ? alphabet[(chunk >> 6) & 0x3f] : padded ? "=" : ""
    result += remaining > 2 ? alphabet[chunk & 0x3f] : padded ? "=" : ""
  }
  return result
}

/** Standard RFC 4648 base64 with padding. Used for the HTTP Basic credentials header. */
export function encodeBase64(bytes: Uint8Array): string {
  return encodeBase64With(bytes, BASE64_STANDARD, true)
}

/** URL-safe base64 with no padding. Used for OAuth state and PKCE values, which travel in URLs. */
export function encodeBase64UrlNoPadding(bytes: Uint8Array): string {
  return encodeBase64With(bytes, BASE64_URL, false)
}

/** Decode base64url (or standard base64) into bytes, with or without `=` padding.
 *
 *  Needed to read a JWT payload. Deliberately tolerant of both alphabets, since the difference is
 *  only in two characters and callers should not have to care which a provider emitted.
 *
 *  @throws if the input contains a character outside the base64 alphabet. */
export function decodeBase64UrlToBytes(encoded: string): Uint8Array {
  const values: number[] = []
  let buffer = 0
  let bits = 0

  for (const char of encoded) {
    if (char === "=") break
    let value = BASE64_STANDARD.indexOf(char)
    if (value === -1) {
      // Fall back to the URL alphabet's two distinct characters.
      if (char === "-") value = 62
      else if (char === "_") value = 63
      else throw new SyntaxError(`Invalid base64 character: ${char}`)
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      values.push((buffer >> bits) & 0xff)
    }
  }

  return new Uint8Array(values)
}
