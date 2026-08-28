import { createSign, generateKeyPairSync } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  GITHUB_OIDC_ISSUER,
  OidcError,
  resetOidcKeyCache,
  SPROUTOS_AUDIENCE,
  verifyGitHubOidcToken,
} from "./github-oidc"

/**
 * The signature check here is the entire security of the deploy exchange: without it, anyone who
 * can construct a JSON object could deploy to anyone's project. Every test below is a specific
 * forgery.
 *
 * A real key pair is generated and GitHub's JWKS endpoint is stubbed, so what is exercised is the
 * actual RSA verification rather than a mock agreeing with itself.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const KID = "test-key-1"

// `generateKeyPairSync` without encoding options returns KeyObjects, so the public one exports to
// JWK directly. Passing it through `createPublicKey` asks for a *private* key to derive from.
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }

function b64(input: object | Buffer): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input))
  return buffer.toString("base64url")
}

const NOW = 1_800_000_000_000
const now = () => NOW

function mint(
  overrides: {
    header?: Record<string, unknown>
    claims?: Record<string, unknown>
    signWith?: import("node:crypto").KeyObject
    tamper?: boolean
  } = {},
): string {
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...overrides.header }
  const claims = {
    iss: GITHUB_OIDC_ISSUER,
    aud: SPROUTOS_AUDIENCE,
    exp: Math.floor(NOW / 1000) + 300,
    nbf: Math.floor(NOW / 1000) - 10,
    repository: "MySproutOS/example",
    repository_owner: "MySproutOS",
    sub: "repo:MySproutOS/example:ref:refs/heads/main",
    ref: "refs/heads/main",
    sha: "abc123",
    workflow: "deploy",
    workflow_ref: "MySproutOS/example/.github/workflows/deploy.yml@refs/heads/main",
    run_id: "42",
    actor: "someone",
    ...overrides.claims,
  }

  const signingInput = `${b64(header)}.${b64(claims)}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  const signature = signer.sign(overrides.signWith ?? privateKey).toString("base64url")

  const payload = overrides.tamper ? b64({ ...claims, repository: "attacker/evil" }) : b64(claims)

  return `${b64(header)}.${payload}.${signature}`
}

beforeEach(() => {
  resetOidcKeyCache()
  vi.stubGlobal("fetch", (url: string) => {
    if (url.includes("jwks")) {
      return Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }))
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("verifyGitHubOidcToken", () => {
  it("accepts a token GitHub actually signed", async () => {
    const claims = await verifyGitHubOidcToken(mint(), now)

    expect(claims.repository).toBe("MySproutOS/example")
    expect(claims.ref).toBe("refs/heads/main")
    expect(claims.workflow).toBe("deploy")
    expect(claims.workflowRef).toBe(
      "MySproutOS/example/.github/workflows/deploy.yml@refs/heads/main",
    )
  })

  it("refuses alg: none", async () => {
    /*
      The oldest JWT forgery there is: set the algorithm to `none`, drop the signature, and a
      verifier that reads its algorithm out of the token accepts anything. The algorithm is decided
      by us, not by the token.
    */
    const header = b64({ alg: "none", kid: KID, typ: "JWT" })
    const payload = b64({ iss: GITHUB_OIDC_ISSUER, aud: SPROUTOS_AUDIENCE, repository: "a/b" })

    await expect(verifyGitHubOidcToken(`${header}.${payload}.`, now)).rejects.toBeInstanceOf(
      OidcError,
    )
  })

  it("refuses a token signed by somebody else's key", async () => {
    // The whole point. An attacker can produce a perfectly-formed token; they cannot produce
    // GitHub's signature.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })

    await expect(verifyGitHubOidcToken(mint({ signWith: other.privateKey }), now)).rejects.toThrow(
      /signature/,
    )
  })

  it("refuses a token whose claims were edited after signing", async () => {
    // Swapping the repository claim for somebody else's is the specific attack: a valid signature
    // over a payload that is no longer the payload.
    await expect(verifyGitHubOidcToken(mint({ tamper: true }), now)).rejects.toThrow(/signature/)
  })

  it("refuses another issuer", async () => {
    // A token correctly signed by a different issuer is a valid token — for something else.
    await expect(
      verifyGitHubOidcToken(mint({ claims: { iss: "https://evil.example.com" } }), now),
    ).rejects.toThrow(/issuer/)
  })

  it("refuses a token minted for a different audience", async () => {
    /*
      GitHub issues a token for whatever audience a workflow asks for. Without this check, a token
      minted for some unrelated service — by a repository that has nothing to do with SproutOS —
      deploys here. The audience is the claim that says "this was made for us".
    */
    await expect(
      verifyGitHubOidcToken(mint({ claims: { aud: "some-other-service" } }), now),
    ).rejects.toThrow(/SproutOS/)
  })

  it("accepts an audience array containing ours", async () => {
    // `aud` is legally a string or an array. Handling only one form rejects valid tokens for the
    // wrong reason.
    const claims = await verifyGitHubOidcToken(
      mint({ claims: { aud: ["other", SPROUTOS_AUDIENCE] } }),
      now,
    )

    expect(claims.repository).toBe("MySproutOS/example")
  })

  it("refuses an expired token", async () => {
    await expect(
      verifyGitHubOidcToken(mint({ claims: { exp: Math.floor(NOW / 1000) - 1 } }), now),
    ).rejects.toThrow(/expired/)
  })

  it("refuses a token that is not valid yet", async () => {
    await expect(
      verifyGitHubOidcToken(mint({ claims: { nbf: Math.floor(NOW / 1000) + 60 } }), now),
    ).rejects.toThrow(/not valid yet/)
  })

  it("refuses an unknown signing key even after refreshing", async () => {
    // An unknown `kid` means rotation or forgery. Refetching answers both — and a key that still
    // does not exist afterwards is not GitHub's.
    await expect(
      verifyGitHubOidcToken(mint({ header: { kid: "not-a-real-kid" } }), now),
    ).rejects.toThrow(/signing key/)
  })

  it("refuses a token with no repository", async () => {
    await expect(
      verifyGitHubOidcToken(mint({ claims: { repository: undefined } }), now),
    ).rejects.toThrow(/repository/)
  })
})
