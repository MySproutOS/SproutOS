import { encodeHexLowerCase, generateUrlSafeToken, sha256Utf8 } from "@utils/crypto"

/**
 * A confidential client's secret: minted here, hashed here, verified here.
 *
 * The pair lives in one module because the two halves are one format, and splitting them is how
 * they drift. They did drift: the issuing route hashed to `sha256$<hex>` while the token endpoint
 * compared against a bare `<hex>`, so the stored and computed values could never be equal and
 * every confidential client was rejected with `invalid_client` no matter what it presented. The
 * strings differ only in a prefix, which is exactly the kind of mismatch that reads as correct in
 * both files and is only visible with both open at once.
 *
 * Nothing outside this module should call `sha256Utf8` on a client secret.
 */

/** `client_secret_` and 32 bytes (256 bits) from the CSPRNG, base64url. */
export function generateClientSecret(): string {
  return `client_secret_${generateUrlSafeToken(32)}`
}

/**
 * Plain SHA-256, the same choice `@lib/api-keys` documents.
 *
 * This is 256 bits nobody chose, so there is nothing for a work factor to make expensive, and it
 * is verified once per token request — a path where Argon2's memory cost would be a
 * denial-of-service lever rather than a defence.
 *
 * The `sha256$` prefix names the algorithm in the stored value, so a future change to it can be
 * rolled out by reading the prefix rather than by rehashing secrets nobody has the plaintext of.
 * It is part of the stored string, so verification must hash through this same function — comparing
 * a bare digest against a stored one will always fail.
 */
export async function hashClientSecret(secret: string): Promise<string> {
  return `sha256$${encodeHexLowerCase(await sha256Utf8(secret))}`
}
