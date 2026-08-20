export class EnvelopeError extends Error {
  override readonly name: string = "EnvelopeError"
}

/**
 * Thrown when the ciphertext, the key, or the encryption context do not agree.
 *
 * Deliberately opaque: the caller learns that decryption failed, not which of
 * the three was wrong, because the difference is an oracle.
 */
export class DecryptionFailedError extends EnvelopeError {
  override readonly name = "DecryptionFailedError"

  constructor() {
    super("Decryption failed")
  }
}

export class MissingKeyError extends EnvelopeError {
  override readonly name = "MissingKeyError"

  constructor() {
    super("No KMS key configured. Set KMS_KEY_ID or pass keyId.")
  }
}

/** Thrown when an encryption context could not be canonicalized unambiguously. */
export class EnvelopeContextError extends EnvelopeError {
  override readonly name = "EnvelopeContextError"
}
