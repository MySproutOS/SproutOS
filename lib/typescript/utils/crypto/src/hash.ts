/** Hashing, delegated to the platform's Web Crypto implementation.
 *
 *  The oslojs crypto package shipped a pure-JS SHA-256. The valuable part of it was the small,
 *  explicit API — not the implementation, which every runtime we target now provides natively via
 *  `crypto.subtle`. Using the native one is faster and is the audited code path, at the cost of
 *  being async. Every caller here is already async.
 *
 *  Available in Node 24, Next.js edge and Node runtimes, and browsers. */

/** Bytes backed by a plain ArrayBuffer.
 *
 *  Web Crypto rejects views over a SharedArrayBuffer, and since TypeScript 5.7 `Uint8Array` is
 *  generic over its buffer, so the plain type is too wide to pass. Both `TextEncoder.encode` and
 *  `new Uint8Array(n)` already produce this narrower type. */
export type Bytes = Uint8Array<ArrayBuffer>

/** SHA-256 of the given bytes. */
export async function sha256(data: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return new Uint8Array(digest)
}

/** SHA-256 of a UTF-8 string — the common case here, since we hash tokens. */
export async function sha256Utf8(data: string): Promise<Bytes> {
  return await sha256(new TextEncoder().encode(data))
}

/** Length-independent equality for secrets, so comparison time leaks nothing about the value.
 *
 *  Length itself is not secret and is compared eagerly; only the contents get the fixed-time
 *  treatment. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i]
  }
  return mismatch === 0
}

/** `constantTimeEqual` for strings, e.g. comparing an OAuth state parameter. */
export function constantTimeEqualUtf8(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  return constantTimeEqual(encoder.encode(a), encoder.encode(b))
}
