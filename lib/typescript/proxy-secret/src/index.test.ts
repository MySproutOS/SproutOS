import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"

import { openFromProxy, ProxySecretUnavailableError, sealForProxy } from "./index"

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/proxy-secret.json", import.meta.url), "utf8"),
) as { key: string; cases: { name: string; plaintext: string; sealed: string }[] }

const original = process.env.LLM_PROXY_SECRET

afterEach(() => {
  if (original === undefined) delete process.env.LLM_PROXY_SECRET
  else process.env.LLM_PROXY_SECRET = original
})

describe("the shared fixtures", () => {
  it("opens every vector the Rust half also opens", () => {
    process.env.LLM_PROXY_SECRET = fixtures.key
    // These exact bytes are the definition of the seam. `lib/rust/llm-proxy` asserts the same file,
    // so a change to either implementation that alters the format fails on both sides rather than
    // producing a router that silently cannot open what the control plane sealed.
    for (const vector of fixtures.cases) {
      // Named in the assertion below via the vector itself; a failure prints both values.
      expect(openFromProxy(vector.sealed)).toBe(vector.plaintext)
    }
  })
})

describe("sealForProxy", () => {
  it("round-trips", () => {
    process.env.LLM_PROXY_SECRET = fixtures.key
    expect(openFromProxy(sealForProxy("sk-ant-abc"))).toBe("sk-ant-abc")
  })

  it("never produces the same bytes twice for the same input", () => {
    process.env.LLM_PROXY_SECRET = fixtures.key
    // A fresh nonce per seal. Repeating one under AES-GCM is catastrophic rather than merely weak,
    // which is why the nonce is random and not a counter — a counter needs state shared between
    // every process that seals, and that is the kind of thing that quietly stops being true.
    const seals = new Set(Array.from({ length: 100 }, () => sealForProxy("same")))
    expect(seals.size).toBe(100)
  })

  it("refuses a tampered value rather than returning wrong plaintext", () => {
    process.env.LLM_PROXY_SECRET = fixtures.key
    const sealed = Buffer.from(sealForProxy("sk-ant-abc"), "base64")
    // Flip a bit in the ciphertext. GCM authenticates, so this must throw and not decrypt to
    // something plausible — an unauthenticated mode here would let anyone with database write
    // access redirect the proxy's credential.
    sealed[sealed.length - 20] ^= 0x01
    expect(() => openFromProxy(sealed.toString("base64"))).toThrow(
      /unable to authenticate data|bad decrypt/i,
    )
  })

  it("says which secret is missing", () => {
    delete process.env.LLM_PROXY_SECRET
    expect(() => sealForProxy("x")).toThrow(ProxySecretUnavailableError)
  })

  it("refuses a key of the wrong length by name", () => {
    process.env.LLM_PROXY_SECRET = Buffer.alloc(16).toString("base64")
    // Node's own error says "Invalid key length" and names nothing. With several secrets in this
    // process, that is a genuinely hard error to place.
    expect(() => sealForProxy("x")).toThrow(/LLM_PROXY_SECRET must be 32 bytes/)
  })
})
