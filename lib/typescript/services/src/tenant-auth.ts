import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"

/**
 * The TypeScript half of `lib/rust/tenant-auth`.
 *
 * The control plane issues connection credentials; the Rust data-plane proxies verify them. Those
 * two live in different languages and share no code, so they share this file's contract instead:
 * the username grammar, the short-id encoding, and the shape of a stored hash.
 *
 * **A divergence here is a security bug, not a formatting one.** If the encodings drift, a proxy
 * either rejects a valid tenant or — far worse — routes one tenant's connection into another's
 * keyspace, because the username *is* the routing information. `tenant-auth.test.ts` asserts the
 * same fixtures the Rust crate's tests assert; changing one without the other should turn a test
 * red on both sides.
 */

/** Lowercase Crockford base32, in canonical order. Must match `ALPHABET` in the Rust crate. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Characters in a short id: 26 digits hold 130 bits, enough for a 128-bit UUID. */
export const SHORT_ID_LEN = 26

/** Bytes of entropy in a generated connection secret. */
export const SECRET_BYTES = 32

/** Prefix marking a stored hash as the SHA-256 kind. Everything else is an Argon2 PHC string. */
const SHA256_PREFIX = "sha256$"

export type ResourceKind = "database" | "queue" | "searchIndex"

/** The two-character username prefix per kind. Mirrors `ResourceKind::prefix` in Rust. */
const KIND_PREFIX: Record<ResourceKind, string> = {
  database: "db",
  queue: "kv",
  searchIndex: "ix",
}

/** The `backend_service.kind` each maps to, which is what the driver registry keys on. */
export const KIND_FOR_SERVICE: Record<string, ResourceKind> = {
  postgres: "database",
  valkey: "queue",
  elasticsearch: "searchIndex",
}

/**
 * Encodes a UUID as 26 characters of lowercase Crockford base32, most significant digit first.
 *
 * This is the ULID text encoding. The leading digit only ever carries the top three bits of the
 * UUID, so it is always `0`-`7` — which the Rust decoder enforces, and which is why a hand-written
 * short id is refused rather than silently decoding to the wrong tenant.
 */
export function encodeShortId(uuid: string): string {
  const hex = uuid.replaceAll("-", "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new RangeError(`${JSON.stringify(uuid)} is not a UUID`)
  }

  let value = BigInt(`0x${hex}`)
  const out = Array.from({ length: SHORT_ID_LEN }, () => "")
  // Filled from the least significant digit backwards, so the most significant digit lands first —
  // which is what makes the encoding sort in the same order as the underlying UUID.
  for (let index = SHORT_ID_LEN - 1; index >= 0; index -= 1) {
    out[index] = ALPHABET[Number(value & 0x1fn)]
    value >>= 5n
  }
  return out.join("")
}

/**
 * The connection username for one tenant resource: `<kind>_<resource>.<organization>`.
 *
 * The wire protocols give a proxy a username and a secret and nothing else — no header, no token,
 * no routing hint — so the username has to carry which resource the connection is for and who owns
 * it. Always 56 bytes, inside Postgres's 63-byte role-name limit.
 */
export function tenantUsername(parts: {
  organizationId: string
  kind: ResourceKind
  resourceId: string
}): string {
  return `${KIND_PREFIX[parts.kind]}_${encodeShortId(parts.resourceId)}.${encodeShortId(parts.organizationId)}`
}

/**
 * Generates a connection secret: 52 characters of Crockford base32 over 256 bits.
 *
 * The alphabet has no `i`, `l`, `o` or `u`, so a secret carries nothing that means something in a
 * URI, a shell, or a YAML file — it goes into a connection string unquoted and unescaped.
 */
export function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))

  let out = ""
  let accumulator = 0
  let bits = 0
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(accumulator >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += ALPHABET[(accumulator << (5 - bits)) & 0x1f]
  return out
}

/**
 * Hashes a secret from `generateSecret` for storage, as `sha256$<hex>`.
 *
 * **Plain SHA-256, deliberately.** Argon2 exists to make a *guessable* secret expensive to guess,
 * and a 256-bit random string is not guessable — the work factor buys nothing against 2^256
 * candidates. What it would buy is a denial-of-service lever on the proxies: every connection
 * attempt costing 19 MiB and tens of milliseconds means a few hundred concurrent ones exhaust a
 * proxy before any of them sends a command. The Rust `verify_secret` reads both encodings, so a
 * credential a human chose can still be stored as Argon2.
 */
export async function hashGeneratedSecret(secret: string): Promise<string> {
  return `${SHA256_PREFIX}${encodeHexLowerCase(await sha256Utf8(secret))}`
}

/** The last four characters, for telling two credentials apart without revealing either. */
export function lastFour(secret: string): string {
  return secret.slice(-4)
}

/**
 * The index-name namespace for one search service: `t<short-id>_`.
 *
 * Mirrors `prefix_for` in `services/search-proxy/src/naming.rs`, which is what actually applies it
 * to a tenant's requests. It is duplicated here rather than exported from there because the control
 * plane needs to name a tenant's indices for exactly one reason — deleting them when the service is
 * destroyed — and a reaper that computed the prefix differently from the proxy would delete either
 * nothing or somebody else's.
 *
 * The leading `t` is load-bearing: a short id starts with a digit `0`-`7`, which is legal, but an
 * index name may not begin with `-`, `_` or `+`, and a fixed letter makes the namespace obvious in
 * an operator's `_cat/indices` output.
 */
export function tenantIndexPrefix(backendServiceId: string): string {
  return `t${encodeShortId(backendServiceId)}_`
}
