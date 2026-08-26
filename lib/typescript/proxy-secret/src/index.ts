import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * The seal between the control plane and the LLM proxy.
 *
 * ## What this is not
 *
 * It is **not** the envelope encryption in `@lib/envelope`, and the difference is the point. That
 * one is KMS-backed and protects everything a customer has entrusted to us. This one protects a
 * single model credential for the lifetime of one sandbox session, and it exists so that the
 * router — a Rust process on a public-facing box — never needs `kms:Decrypt` on the envelope key.
 * A router that could open KMS ciphertext could open every customer credential in the account; a
 * router that can open this can open the one session it is already proxying.
 *
 * ## The shape
 *
 * AES-256-GCM. `nonce || ciphertext || tag`, base64. The nonce is 12 bytes, which is what GCM is
 * specified for and what both implementations default to; the tag is 16.
 *
 * **A random nonce, never a counter.** Twelve random bytes gives a birthday bound far beyond the
 * number of tokens this platform will ever mint, and a counter would need state shared between
 * every process that seals — which is exactly the kind of coordination that quietly stops being
 * true and repeats a nonce, which for GCM is catastrophic rather than merely weak.
 *
 * ## Two implementations, one definition
 *
 * The Rust half is in `lib/rust/llm-proxy` and reads the same fixtures this asserts against, for
 * the reason `AGENTS.md` gives about every cross-language seam: a divergence here is a security
 * bug, not an inconvenience. `fixtures/proxy-secret.json` is that definition.
 */

const NONCE_BYTES = 12
const TAG_BYTES = 16

export class ProxySecretUnavailableError extends Error {
  override readonly name = "ProxySecretUnavailableError"

  constructor() {
    super(
      "LLM_PROXY_SECRET is not set, so a sandbox credential cannot be sealed for the proxy. " +
        "Without it the agent would have to hold the customer's model credential directly.",
    )
  }
}

/**
 * The shared key, as 32 bytes.
 *
 * Read per call rather than cached at module load: a process that started before the secret was
 * present should pick it up on the next attempt rather than fail forever, and this is not on a hot
 * path — it runs once per token mint.
 */
function key(): Buffer {
  const configured = process.env.LLM_PROXY_SECRET
  if (configured === undefined || configured === "") throw new ProxySecretUnavailableError()

  const bytes = Buffer.from(configured, "base64")
  if (bytes.length !== 32) {
    // Named, because the alternative is `createCipheriv` throwing about an "invalid key length"
    // and nobody knowing which of several secrets it meant.
    throw new Error(
      `LLM_PROXY_SECRET must be 32 bytes of base64 — got ${bytes.length}. ` +
        "Generate one with: openssl rand -base64 32",
    )
  }
  return bytes
}

export function sealForProxy(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key(), nonce)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64")
}

/**
 * Open a sealed value. Present here so the control plane can verify its own output, and so the
 * fixtures can be asserted from both directions rather than only generated.
 */
export function openFromProxy(sealed: string): string {
  const bytes = Buffer.from(sealed, "base64")
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("sealed value is too short to contain a nonce and a tag")
  }

  const nonce = bytes.subarray(0, NONCE_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const body = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)

  const decipher = createDecipheriv("aes-256-gcm", key(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
}
