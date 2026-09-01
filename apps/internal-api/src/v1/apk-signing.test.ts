import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import {
  assertSignerCredentialConfiguration,
  callbackIdempotencyKey,
  signerAuthorized,
  signerOperatorAuthorized,
} from "./apk-signing"

/**
 * The signer is the one caller that is neither a session nor inside the VPC, so this bearer check
 * is the whole of its authorization.
 */
const TOKEN = "signer-token-value"

afterEach(() => {
  delete process.env.APK_SIGNER_TOKEN
  delete process.env.APK_SIGNER_OPERATOR_TOKEN
})

describe("the signer credential", () => {
  it("accepts the configured token", () => {
    process.env.APK_SIGNER_TOKEN = TOKEN

    expect(signerAuthorized(`Bearer ${TOKEN}`)).toBe(true)
  })

  it("tolerates the future distinct operator credential without changing runtime authorization", () => {
    // Infrastructure delivers both names before #192 lands. The current image must stay healthy
    // and continue authenticating runtime signer calls solely with its existing credential.
    process.env.APK_SIGNER_TOKEN = TOKEN
    process.env.APK_SIGNER_OPERATOR_TOKEN = "distinct-future-operator-token"

    expect(signerAuthorized(`Bearer ${TOKEN}`)).toBe(true)
    expect(signerAuthorized("Bearer distinct-future-operator-token")).toBe(false)
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

  it("uses a distinct fail-closed credential for canonical-client operator actions", () => {
    process.env.APK_SIGNER_TOKEN = TOKEN
    process.env.APK_SIGNER_OPERATOR_TOKEN = "operator-token-value"

    expect(signerAuthorized(`Bearer ${TOKEN}`)).toBe(true)
    expect(signerAuthorized("Bearer operator-token-value")).toBe(false)
    expect(signerOperatorAuthorized("Bearer operator-token-value")).toBe(true)
    expect(signerOperatorAuthorized(`Bearer ${TOKEN}`)).toBe(false)

    process.env.APK_SIGNER_OPERATOR_TOKEN = TOKEN
    expect(signerAuthorized(`Bearer ${TOKEN}`)).toBe(false)
    expect(signerOperatorAuthorized(`Bearer ${TOKEN}`)).toBe(false)
  })

  it("rejects missing or shared credentials during production startup", () => {
    expect(() => {
      assertSignerCredentialConfiguration({})
    }).toThrow(/required/)
    expect(() => {
      assertSignerCredentialConfiguration({
        APK_SIGNER_TOKEN: TOKEN,
        APK_SIGNER_OPERATOR_TOKEN: TOKEN,
      })
    }).toThrow(/distinct/)
    expect(() => {
      assertSignerCredentialConfiguration({
        APK_SIGNER_TOKEN: TOKEN,
        APK_SIGNER_OPERATOR_TOKEN: "operator-token-value",
      })
    }).not.toThrow()
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
          claim_token: "d".repeat(64),
          signed_key: `signed/client/${jobId}.apk`,
          signed_object_version: "version-two",
          signed_digest: "b".repeat(64),
          size_bytes: 84,
          package_name: "com.sproutos.store",
          version_code: 2,
          version_name: "0.2.0",
          certificate_sha256: "c".repeat(64),
          developer_console_account: "developerAccounts/123",
        },
        "bcde482511c29bca8a009add26dfbba0a994b551191b2f386a3401a7c4ec4646",
      ],
      [
        {
          job_id: jobId,
          signer_id: "signer-01",
          claim_token: "d".repeat(64),
          error: "verification failed",
        },
        "5693763c94f32034803c04a362c6f00704de8253adbed2c71de5c942f313944d",
      ],
    ]
    for (const [payload, key] of vectors) {
      expect(createHash("sha256").update(JSON.stringify(payload)).digest("hex")).toBe(key)
      expect(callbackIdempotencyKey(key, payload)).toBe(key)
    }
  })
})
