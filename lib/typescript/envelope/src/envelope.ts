import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms"
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"
import { DecryptionFailedError, EnvelopeContextError, MissingKeyError } from "./errors"
import type { EncryptionContext, EnvelopeConfig, SealedValue } from "./types"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16

/** ASCII unit and record separators, which cannot appear in a validated context. */
const UNIT_SEPARATOR = "\u001f"
const RECORD_SEPARATOR = "\u001e"

let cachedClient: KMSClient | undefined

function kmsClient(config: EnvelopeConfig = {}): KMSClient {
  if (cachedClient) return cachedClient

  const endpoint = config.endpoint ?? process.env.AWS_ENDPOINT_URL
  const options: KMSClientConfig = {
    region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
  }

  // AWS_ENDPOINT_URL is the SDK's own standard variable. Gating on it means the
  // same code path runs against LocalStack in development and real KMS in
  // production, with no branch in the application.
  if (endpoint) {
    options.endpoint = endpoint
    options.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    }
  }

  cachedClient = new KMSClient(options)
  return cachedClient
}

/** Test seam. Drops the memoized client so the next call rebuilds from the environment. */
export function resetEnvelopeClient(): void {
  cachedClient = undefined
}

function resolveKeyId(config: EnvelopeConfig): string {
  const keyId = config.keyId ?? process.env.KMS_KEY_ID
  if (!keyId) throw new MissingKeyError()
  return keyId
}

/**
 * Encrypts a value under a fresh single-use data key.
 *
 * KMS never sees the plaintext: it mints a data key, we encrypt locally with
 * AES-256-GCM, and we store the wrapped key beside the ciphertext. The
 * encryption context is authenticated on both halves — the KMS request and the
 * GCM additional data — so a ciphertext is only decryptable in the place it was
 * sealed for.
 */
export async function seal(
  plaintext: string,
  context: EncryptionContext = {},
  config: EnvelopeConfig = {},
): Promise<SealedValue> {
  const keyId = resolveKeyId(config)
  assertContextSafe(context)

  const generated = await kmsClient(config).send(
    new GenerateDataKeyCommand({
      KeyId: keyId,
      KeySpec: "AES_256",
      EncryptionContext: context,
    }),
  )

  if (!generated.Plaintext || !generated.CiphertextBlob) {
    throw new DecryptionFailedError()
  }

  const dek = Buffer.from(generated.Plaintext)
  try {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, dek, iv)
    cipher.setAAD(additionalData(context))
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()

    return {
      ciphertext: Buffer.concat([iv, body, tag]).toString("base64"),
      wrappedDek: Buffer.from(generated.CiphertextBlob).toString("base64"),
      kmsKeyId: generated.KeyId ?? keyId,
    }
  } finally {
    // The data key is single-use; there is no reason for it to outlive the call.
    dek.fill(0)
  }
}

/**
 * Reverses {@link seal}.
 *
 * Every failure — wrong key, tampered ciphertext, mismatched context — raises
 * the same error, because distinguishing them for a caller also distinguishes
 * them for an attacker.
 */
export async function open(
  sealed: SealedValue,
  context: EncryptionContext = {},
  config: EnvelopeConfig = {},
): Promise<string> {
  assertContextSafe(context)

  const raw = Buffer.from(sealed.ciphertext, "base64")
  if (raw.length < IV_BYTES + TAG_BYTES) throw new DecryptionFailedError()

  let dek: Buffer
  try {
    const decrypted = await kmsClient(config).send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(sealed.wrappedDek, "base64"),
        EncryptionContext: context,
        KeyId: sealed.kmsKeyId,
      }),
    )
    if (!decrypted.Plaintext) throw new DecryptionFailedError()
    dek = Buffer.from(decrypted.Plaintext)
  } catch {
    throw new DecryptionFailedError()
  }

  try {
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)

    const decipher = createDecipheriv(ALGORITHM, dek, iv)
    decipher.setAAD(additionalData(context))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
  } catch {
    throw new DecryptionFailedError()
  } finally {
    dek.fill(0)
  }
}

/**
 * Canonical bytes for the GCM additional authenticated data.
 *
 * Keys are sorted so two callers building the same logical context in different
 * orders produce identical bytes. The separators are control characters that
 * {@link assertContextSafe} forbids in keys and values, so no two distinct
 * contexts can serialize the same way.
 */
function additionalData(context: EncryptionContext): Buffer {
  const entries = Object.entries(context).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const encoded = entries.map(([k, v]) => `${k}${UNIT_SEPARATOR}${v}`).join(RECORD_SEPARATOR)
  return Buffer.from(encoded, "utf8")
}

function assertContextSafe(context: EncryptionContext): void {
  for (const [key, value] of Object.entries(context)) {
    if (key.length === 0)
      throw new EnvelopeContextError("Encryption context keys must be non-empty")
    if (
      key.includes(UNIT_SEPARATOR) ||
      key.includes(RECORD_SEPARATOR) ||
      value.includes(UNIT_SEPARATOR) ||
      value.includes(RECORD_SEPARATOR)
    ) {
      throw new EnvelopeContextError("Encryption context must not contain ASCII separators")
    }
  }
}

/** Constant-time comparison for callers checking a secret against a stored value. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // timingSafeEqual throws on a length mismatch, and the length of a secret is
  // not itself sensitive here.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
