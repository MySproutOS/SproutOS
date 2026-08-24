import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { canonical, jsonString, quantityBits, sign, type UsageBatch, verify } from "./canonical"
import { parseBatch } from "./parse"

/**
 * The cross-language contract, asserted from the TypeScript side against the same vectors the Rust
 * crate asserts against.
 *
 * `AGENTS.md` calls a divergence here a security bug. It is more mundane than that and just as bad:
 * a divergence means the agent signs a batch this rejects, and rejected usage is usage nobody is
 * charged for. Neither side notices — the agent logs a failure it will retry forever, and the
 * invoice is simply smaller than it should be.
 */
const FIXTURES = "../../../rust/metering-proto/fixtures/signing-vectors.json"

type Vector = {
  name: string
  key_hex: string
  batch: {
    source: string
    events: {
      external_id: string
      organization_id: string
      project_id: string | null
      dimension: string
      quantity: number
      occurred_at: number
      attributes?: Record<string, string>
    }[]
  }
  canonical: string
  signature: string
}

const fixtures = JSON.parse(readFileSync(new URL(FIXTURES, import.meta.url), "utf8")) as {
  domain: string
  vectors: Vector[]
}

function batchOf(vector: Vector): UsageBatch {
  const parsed = parseBatch(vector.batch)
  if (!parsed.ok) throw new Error(`fixture "${vector.name}" does not parse: ${parsed.reason}`)
  return parsed.batch
}

describe("the signing contract", () => {
  it("has vectors to check against", () => {
    // A fixture file that failed to load would make every test below vacuously pass.
    expect(fixtures.vectors.length).toBeGreaterThan(0)
  })

  it.each(fixtures.vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces the canonical form for %s",
    (_name, vector) => {
      expect(canonical(batchOf(vector))).toBe(vector.canonical)
    },
  )

  it.each(fixtures.vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces the signature for %s",
    (_name, vector) => {
      const key = Buffer.from(vector.key_hex, "hex")

      expect(sign(batchOf(vector), key)).toBe(vector.signature)
      expect(verify(batchOf(vector), key, vector.signature)).toBe(true)
    },
  )
})

describe("quantityBits", () => {
  it("writes the IEEE-754 big-endian bit pattern", () => {
    // 1.0 is 0x3ff0000000000000. Big-endian: the exponent byte comes first.
    expect(quantityBits(1)).toBe("3ff0000000000000")
    expect(quantityBits(0)).toBe("0000000000000000")
  })

  it("distinguishes values a decimal round trip could confuse", () => {
    // The whole reason the contract signs bits rather than a decimal spelling.
    expect(quantityBits(0.1 + 0.2)).not.toBe(quantityBits(0.3))
  })
})

describe("verify", () => {
  const batch: UsageBatch = {
    source: "node-a",
    events: [
      {
        externalId: "e1",
        organizationId: "01a01e12-1700-76ac-9713-dd208babdf5a",
        projectId: null,
        dimension: "site_gib_second",
        quantity: 0.2,
        occurredAt: 1_700_000_000_000,
        attributes: {},
      },
    ],
  }
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex")

  it("rejects a signature over a different quantity", () => {
    // The point of signing at all: an altered number fails rather than being rebilled.
    const tampered: UsageBatch = { ...batch, events: [{ ...batch.events[0], quantity: 20 }] }

    expect(verify(tampered, key, sign(batch, key))).toBe(false)
  })

  it("rejects a signature made with a different key", () => {
    expect(verify(batch, Buffer.alloc(16), sign(batch, key))).toBe(false)
  })

  it("accepts exactly one spelling of a signature", () => {
    // Uppercase hex is the same bytes and is refused, so a replay cache keyed on the string cannot
    // be walked around by changing case.
    expect(verify(batch, key, sign(batch, key).toUpperCase())).toBe(false)
  })

  it("returns false rather than throwing on a malformed signature", () => {
    // `timingSafeEqual` throws on a length mismatch, and a 500 on a malformed signature is a worse
    // answer than a 401.
    for (const bad of ["", "zz", "0".repeat(63), "0".repeat(65), "nothex".repeat(11)]) {
      expect(verify(batch, key, bad)).toBe(false)
    }
  })
})

describe("jsonString", () => {
  it("escapes what JSON requires and nothing else", () => {
    expect(jsonString('a"b')).toBe('"a\\"b"')
    expect(jsonString("a\\b")).toBe('"a\\\\b"')
    expect(jsonString("a\nb")).toBe('"a\\nb"')
    expect(jsonString(`a${String.fromCharCode(1)}b`)).toBe('"a\\u0001b"')
    // Not escaped: a non-ASCII character is written through, matching the Rust encoder.
    expect(jsonString("café")).toBe('"café"')
  })
})
