/**
 * The stored form of an encrypted value.
 *
 * Every secret column in the database follows this shape as
 * `{field}_ciphertext`, `{field}_wrapped_dek`, `{field}_kms_key_id`. Four
 * separate designs for this existed across the planning notes; this is the only
 * one, so a reader of any table knows what they are looking at.
 */
export type SealedValue = {
  /** AES-256-GCM output: 12-byte IV ‖ ciphertext ‖ 16-byte auth tag, base64. */
  ciphertext: string
  /** The data key, encrypted under the CMK. Base64 of the KMS blob. */
  wrappedDek: string
  /** Which CMK wrapped the data key, so rotation can find what to re-wrap. */
  kmsKeyId: string
}

/**
 * Additional authenticated data bound into the ciphertext and into the KMS
 * request.
 *
 * This is what stops a ciphertext being lifted from one row and pasted into
 * another: decryption of a value sealed for organization A fails outright when
 * presented as organization B's, rather than quietly succeeding.
 */
export type EncryptionContext = Record<string, string>

export type EnvelopeConfig = {
  /** CMK id or alias. Defaults to `KMS_KEY_ID`. */
  keyId?: string
  /** Overrides the KMS endpoint. Defaults to `AWS_ENDPOINT_URL` (LocalStack). */
  endpoint?: string
  region?: string
}
