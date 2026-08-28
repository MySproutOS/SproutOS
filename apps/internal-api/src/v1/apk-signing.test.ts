import { afterEach, describe, expect, it } from "vitest"
import { callbackIdempotencyKey, signerAuthorized } from "./apk-signing"

/**
 * The signer is the one caller that is neither a session nor inside the VPC, so this bearer check
 * is the whole of its authorization.
 */
const TOKEN = "signer-token-value"

afterEach(() => {
  delete process.env.APK_SIGNER_TOKEN
})

describe("the signer credential", () => {
  it("accepts the configured token", () => {
    process.env.APK_SIGNER_TOKEN = TOKEN

    expect(signerAuthorized(`Bearer ${TOKEN}`)).toBe(true)
  })

  it("refuses every caller when no token is configured", () => {
    // The failure worth naming: an unconfigured deployment must refuse everyone. If the empty
    // string were compared as a value, `Bearer ` — or a header the caller controls entirely — would
    // match it, and the queue would be open to the internet the moment somebody forgot the env var.
    expect(signerAuthorized("Bearer ")).toBe(false)
    expect(signerAuthorized("Bearer anything")).toBe(false)
    expect(signerAuthorized(undefined)).toBe(false)

    process.env.APK_SIGNER_TOKEN = ""
    expect(signerAuthorized("Bearer ")).toBe(false)
  })

  it("refuses a wrong token, a missing header, and a missing scheme", () => {
    process.env.APK_SIGNER_TOKEN = TOKEN

    expect(signerAuthorized(`Bearer ${TOKEN}x`)).toBe(false)
    expect(signerAuthorized("Bearer signer-token-valuf")).toBe(false)
    expect(signerAuthorized(undefined)).toBe(false)
    // No scheme: the raw token is not a credential, or `startsWith` would be doing the work of the
    // comparison and a header of the right shape could be assembled from a prefix.
    expect(signerAuthorized(TOKEN)).toBe(false)
    expect(signerAuthorized(`bearer ${TOKEN}`)).toBe(false)
  })
})

describe("signer callback idempotency", () => {
  it("requires the stable SHA-256 key emitted by the signer", () => {
    const key = "a".repeat(64)
    expect(callbackIdempotencyKey(key)).toBe(key)
    expect(callbackIdempotencyKey(undefined)).toBeUndefined()
    expect(callbackIdempotencyKey("a".repeat(63))).toBeUndefined()
    expect(callbackIdempotencyKey("A".repeat(64))).toBeUndefined()
  })
})
