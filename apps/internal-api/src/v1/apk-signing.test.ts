import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
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
    const payload = { job_id: "job" }
    const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    expect(callbackIdempotencyKey(key, payload)).toBe(key)
    expect(callbackIdempotencyKey(undefined, payload)).toBeUndefined()
    expect(callbackIdempotencyKey("a".repeat(63), payload)).toBeUndefined()
    expect(callbackIdempotencyKey("A".repeat(64), payload)).toBeUndefined()
  })

  it("binds the callback key to the exact signer JSON payload", () => {
    const payload = {
      job_id: "01993d6d-0b31-7000-8000-000000000000",
      signer_id: "signer-1",
      error: "tool failed",
    }
    const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    expect(callbackIdempotencyKey(key, payload)).toBe(key)
    expect(callbackIdempotencyKey(key, { ...payload, error: "different" })).toBeUndefined()
  })

  it("matches the Rust signer's frozen callback JSON vectors", () => {
    const jobId = "019d0000-0000-7000-8000-000000000007"
    const vectors: [unknown, string][] = [
      [
        {
          job_id: jobId,
          signer_id: "signer-01",
          unsigned_key: `raw/client/${jobId}.apk`,
          unsigned_object_version: "version-one",
          unsigned_digest: "a".repeat(64),
          size_bytes: 42,
        },
        "a538ce266aa6b86af1e526112f3de0908d14a1c8ce807aa5ef589b5d5223bbf6",
      ],
      [
        {
          kind: "sign_client_release",
          job_id: jobId,
          signer_id: "signer-01",
          signed_key: `signed/client/${jobId}.apk`,
          signed_object_version: "version-two",
          signed_digest: "b".repeat(64),
          size_bytes: 84,
          package_name: "com.sproutos.store",
          version_code: 2,
          version_name: "0.2.0",
          certificate_sha256: "c".repeat(64),
        },
        "af4e0342e2c355cd697dcaf6731c2aad56d92a88b2c48afcd3cb0c0309cad13e",
      ],
      [
        { job_id: jobId, signer_id: "signer-01", error: "verification failed" },
        "6eefaec98cefc61fa4ecf8df21d3d2837b2866ab4f4b9d534c53b8d600cb7a5c",
      ],
    ]
    for (const [payload, key] of vectors) {
      expect(createHash("sha256").update(JSON.stringify(payload)).digest("hex")).toBe(key)
      expect(callbackIdempotencyKey(key, payload)).toBe(key)
    }
  })
})
