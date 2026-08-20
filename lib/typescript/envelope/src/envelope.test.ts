import { beforeAll, describe, expect, it } from "vitest"
import {
  DecryptionFailedError,
  EnvelopeContextError,
  MissingKeyError,
  open,
  resetEnvelopeClient,
  seal,
  secretEquals,
} from "./index"

/**
 * These run against the KMS that `docker compose up` provides through
 * LocalStack, which carries KMS on its free plan. That is the whole reason the
 * package has no home-rolled crypto fallback: the same code path runs here and
 * in production, so a passing test means the production path works.
 *
 * Skipped when the endpoint is absent, so a checkout without Docker still runs
 * the rest of the suite.
 */
const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
const keyId = process.env.KMS_KEY_ID ?? "alias/sproutos-dev"

async function kmsReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

let available = false

beforeAll(async () => {
  process.env.AWS_ENDPOINT_URL ??= endpoint
  process.env.AWS_REGION ??= "us-east-1"
  process.env.AWS_ACCESS_KEY_ID ??= "test"
  process.env.AWS_SECRET_ACCESS_KEY ??= "test"
  process.env.KMS_KEY_ID ??= keyId
  resetEnvelopeClient()
  available = await kmsReachable()
})

describe("secretEquals", () => {
  it("matches identical strings", () => {
    expect(secretEquals("hunter2", "hunter2")).toBe(true)
  })

  it("rejects different strings of equal length", () => {
    expect(secretEquals("hunter2", "hunter3")).toBe(false)
  })

  it("rejects different lengths without throwing", () => {
    expect(secretEquals("short", "considerably longer")).toBe(false)
  })
})

describe("encryption context validation", () => {
  it("rejects a separator smuggled into a value", async () => {
    await expect(seal("x", { org: "ab" })).rejects.toBeInstanceOf(EnvelopeContextError)
  })

  it("rejects an empty key", async () => {
    await expect(seal("x", { "": "value" })).rejects.toBeInstanceOf(EnvelopeContextError)
  })
})

describe("seal and open", () => {
  it("requires a key", async () => {
    const saved = process.env.KMS_KEY_ID
    delete process.env.KMS_KEY_ID
    try {
      await expect(seal("x")).rejects.toBeInstanceOf(MissingKeyError)
    } finally {
      process.env.KMS_KEY_ID = saved
    }
  })

  it("round-trips a value", async ({ skip }) => {
    if (!available) skip()
    const sealed = await seal("ghp_exampletoken")
    expect(sealed.ciphertext).not.toContain("ghp_")
    expect(await open(sealed)).toBe("ghp_exampletoken")
  })

  it("round-trips unicode and empty strings", async ({ skip }) => {
    if (!available) skip()
    const values = ["", "🌱 sprout", "ünïcödé — em dash", "a".repeat(4096)]
    const roundTripped = await Promise.all(values.map(async (v) => open(await seal(v))))
    expect(roundTripped).toEqual(values)
  })

  it("produces a different ciphertext each time", async ({ skip }) => {
    if (!available) skip()
    const a = await seal("same")
    const b = await seal("same")
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.wrappedDek).not.toBe(b.wrappedDek)
  })

  it("binds the ciphertext to its encryption context", async ({ skip }) => {
    if (!available) skip()
    const context = { organizationId: "org-a", field: "github_access_token" }
    const sealed = await seal("secret", context)

    expect(await open(sealed, context)).toBe("secret")
    // The point of the context: a row's ciphertext is useless in another row.
    await expect(
      open(sealed, { organizationId: "org-b", field: "github_access_token" }),
    ).rejects.toBeInstanceOf(DecryptionFailedError)
    await expect(open(sealed, {})).rejects.toBeInstanceOf(DecryptionFailedError)
  })

  it("is insensitive to context key ordering", async ({ skip }) => {
    if (!available) skip()
    const sealed = await seal("secret", { b: "2", a: "1" })
    expect(await open(sealed, { a: "1", b: "2" })).toBe("secret")
  })

  it("rejects a tampered ciphertext", async ({ skip }) => {
    if (!available) skip()
    const sealed = await seal("secret")
    const raw = Buffer.from(sealed.ciphertext, "base64")
    raw[raw.length - 1] ^= 0xff
    await expect(open({ ...sealed, ciphertext: raw.toString("base64") })).rejects.toBeInstanceOf(
      DecryptionFailedError,
    )
  })

  it("rejects a truncated ciphertext", async ({ skip }) => {
    if (!available) skip()
    const sealed = await seal("secret")
    await expect(open({ ...sealed, ciphertext: "AAAA" })).rejects.toBeInstanceOf(
      DecryptionFailedError,
    )
  })

  it("rejects a wrapped key that does not belong to the ciphertext", async ({ skip }) => {
    if (!available) skip()
    const a = await seal("first")
    const b = await seal("second")
    await expect(open({ ...a, wrappedDek: b.wrappedDek })).rejects.toBeInstanceOf(
      DecryptionFailedError,
    )
  })
})
