/**
 * The TypeScript half of the metering signing contract.
 *
 * The Rust agent signs a batch; this verifies it. Both sides assert against one set of fixture
 * vectors — `lib/rust/metering-proto/fixtures/signing-vectors.json` — because a divergence here is
 * not a bug that produces a wrong number. It produces a rejected batch, and a rejected batch is
 * usage nobody is charged for.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { BillableDimension } from "./dimensions"

/** Prefixed to the canonical form so a signature over one kind of payload cannot be replayed as another. */
export const CANONICAL_DOMAIN = "sproutos.metering.v1"

/** 32 bytes as 64 lowercase hex digits. */
const SIGNATURE_HEX_LENGTH = 64

export type UsageEvent = {
  externalId: string
  organizationId: string
  projectId: string | null
  /** Absent only on the legacy signed shape, whose canonical bytes must remain verifiable. */
  chargedExternally?: boolean
  dimension: BillableDimension
  quantity: number
  occurredAt: number
  attributes: Record<string, string>
}

export type UsageBatch = {
  source: string
  events: UsageEvent[]
}

/**
 * A quantity as the 16 lowercase hex digits of its IEEE-754 big-endian bit pattern.
 *
 * **This is the load-bearing part of the whole contract.** `1e21`, `0.0078125` and `1e-7` have
 * different shortest-decimal spellings in Rust and JavaScript, and a decimal round trip can lose the
 * last bit outright. Signing the bits means the two implementations cannot disagree about a number
 * they both hold identically, and a quantity altered anywhere in flight fails verification rather
 * than being silently rebilled.
 */
export function quantityBits(quantity: number): string {
  const view = new DataView(new ArrayBuffer(8))
  // Big-endian, matching Rust's `to_be_bytes`.
  view.setFloat64(0, quantity, false)

  let out = ""
  for (let index = 0; index < 8; index += 1) {
    out += view.getUint8(index).toString(16).padStart(2, "0")
  }
  return out
}

/**
 * A JSON string literal, escaping exactly what JSON requires and nothing else.
 *
 * Written out rather than using `JSON.stringify`, which is *nearly* the same and not quite: it
 * escapes lone surrogates as `\udXXX` where Rust's `char`-based encoder cannot produce them at all,
 * and the two disagree on nothing else. Matching the Rust byte for byte is the only property that
 * matters here, so the rule is spelled out in both places rather than inferred from a built-in.
 */
export function jsonString(value: string): string {
  let out = '"'

  for (const character of value) {
    switch (character) {
      case '"':
        out += '\\"'
        break
      case "\\":
        out += "\\\\"
        break
      case "\b":
        out += "\\b"
        break
      case "\f":
        out += "\\f"
        break
      case "\n":
        out += "\\n"
        break
      case "\r":
        out += "\\r"
        break
      case "\t":
        out += "\\t"
        break
      default: {
        const code = character.codePointAt(0) ?? 0
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character
      }
    }
  }

  return `${out}"`
}

/**
 * The exact bytes that get signed.
 *
 * Not the wire format. The wire format is ordinary JSON in which `quantity` is a number; a verifier
 * parses that and rebuilds this from the parsed values. Keys are in ascending order, there is no
 * insignificant whitespace, and every optional field is present — `null` when absent — so that two
 * encoders with different opinions about omitting nulls still produce the same string.
 */
export function canonical(batch: UsageBatch): string {
  const events = batch.events.map((event) => {
    const attributes = Object.keys(event.attributes)
      .toSorted()
      .map((key) => `${jsonString(key)}:${jsonString(event.attributes[key] ?? "")}`)
      .join(",")

    return (
      `{"attributes":{${attributes}}` +
      (event.chargedExternally === undefined
        ? ""
        : `,"charged_externally":${event.chargedExternally}`) +
      `,"dimension":${jsonString(event.dimension)}` +
      `,"external_id":${jsonString(event.externalId)}` +
      `,"occurred_at":${event.occurredAt}` +
      `,"organization_id":${jsonString(event.organizationId)}` +
      `,"project_id":${event.projectId === null ? "null" : jsonString(event.projectId)}` +
      `,"quantity":${jsonString(quantityBits(event.quantity))}}`
    )
  })

  return `${CANONICAL_DOMAIN}\n{"events":[${events.join(",")}],"source":${jsonString(batch.source)}}`
}

export function sign(batch: UsageBatch, key: Buffer | string): string {
  return createHmac("sha256", key).update(canonical(batch), "utf8").digest("hex")
}

/**
 * Constant-time verification.
 *
 * Exactly one encoding is accepted — 64 lowercase hex digits — so a signature has a single spelling
 * and a replay cache keyed on the string cannot be walked around by changing its case.
 */
export function verify(batch: UsageBatch, key: Buffer | string, signature: string): boolean {
  if (signature.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-f]+$/.test(signature)) return false

  const expected = Buffer.from(sign(batch, key), "hex")
  const given = Buffer.from(signature, "hex")

  // Lengths are equal by construction above, but `timingSafeEqual` throws rather than returning
  // false when they are not — and a 500 on a malformed signature is a worse answer than a 401.
  if (expected.length !== given.length) return false

  return timingSafeEqual(expected, given)
}
