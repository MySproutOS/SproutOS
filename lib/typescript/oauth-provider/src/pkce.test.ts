import { encodeBase64UrlNoPadding, sha256Utf8 } from "@utils/crypto"
import { describe, expect, it } from "vitest"
import { verifyPkce } from "./pkce"
import {
  assertRegisteredRedirect,
  assertValidRedirectRegistration,
  matchesRegisteredRedirect,
} from "./redirect"
import { OAuthError } from "./errors"

const VERIFIER = "a".repeat(43)

async function challengeFor(verifier: string): Promise<string> {
  return encodeBase64UrlNoPadding(await sha256Utf8(verifier))
}

describe("verifyPkce", () => {
  it("accepts the verifier the challenge was derived from", async () => {
    expect(await verifyPkce(VERIFIER, await challengeFor(VERIFIER))).toBe(true)
  })

  it("rejects any other verifier", async () => {
    expect(await verifyPkce("b".repeat(43), await challengeFor(VERIFIER))).toBe(false)
  })

  it("rejects a verifier that is really the challenge", async () => {
    // The `plain` method is a challenge equal to the verifier, so anyone who saw the challenge
    // travel in a query string can produce the verifier. Accepting it is no protection at all,
    // and the database refuses to store the method too.
    const challenge = await challengeFor(VERIFIER)
    expect(await verifyPkce(challenge, challenge)).toBe(false)
  })

  it("rejects a verifier too short to be worth guessing against", async () => {
    // RFC 7636 sets a 43-character floor precisely so the verifier cannot be brute-forced from
    // the challenge. Enforcing it is part of the security property, not input tidiness.
    const short = "a".repeat(42)
    expect(await verifyPkce(short, await challengeFor(short))).toBe(false)
  })

  it("rejects a verifier outside the permitted alphabet", async () => {
    const bad = `${"a".repeat(42)}%`
    expect(await verifyPkce(bad, await challengeFor(bad))).toBe(false)
  })
})

describe("assertRegisteredRedirect", () => {
  const registered = ["https://app.example.com/callback"]

  it("accepts an exact match", () => {
    expect(assertRegisteredRedirect(registered[0], registered)).toBe(registered[0])
  })

  it("refuses everything that is not exactly the registered string", () => {
    // Each of these is a relaxation someone has shipped, and each one is an open redirect.
    const attempts = [
      "https://app.example.com/callback/", // trailing slash
      "https://app.example.com/callback/../../evil", // prefix matching
      "https://app.example.com/callback?next=https://evil.example", // extra query
      "https://APP.example.com/callback", // case folding
      "https://evil.example/callback",
      "https://app.example.com.evil.example/callback", // suffix confusion
    ]

    for (const attempt of attempts) {
      expect(() => assertRegisteredRedirect(attempt, registered)).toThrow(OAuthError)
    }
  })

  it("refuses a client with nothing registered", () => {
    expect(() => assertRegisteredRedirect("https://app.example.com/cb", [])).toThrow(OAuthError)
  })

  it("allows only the ephemeral port to vary for an RFC 8252 loopback template", () => {
    const template = "http://127.0.0.1/oauth/callback"

    expect(matchesRegisteredRedirect("http://127.0.0.1:49152/oauth/callback", template)).toBe(true)
    expect(assertRegisteredRedirect("http://127.0.0.1:65535/oauth/callback", [template])).toBe(
      "http://127.0.0.1:65535/oauth/callback",
    )
  })

  it("does not widen any other part of a loopback redirect", () => {
    const template = "http://127.0.0.1/oauth/callback"
    for (const attempt of [
      "http://localhost:49152/oauth/callback",
      "http://[::1]:49152/oauth/callback",
      "http://127.0.0.1:49152/oauth/callback/",
      "http://127.0.0.1:49152/oauth/callback?next=/evil",
      "http://127.0.0.1:49152/other",
      "https://127.0.0.1:49152/oauth/callback",
    ]) {
      expect(matchesRegisteredRedirect(attempt, template)).toBe(false)
      expect(() => assertRegisteredRedirect(attempt, [template])).toThrow(OAuthError)
    }
  })

  it("keeps a registered fixed loopback port exact", () => {
    expect(
      matchesRegisteredRedirect(
        "http://127.0.0.1:49153/oauth/callback",
        "http://127.0.0.1:49152/oauth/callback",
      ),
    ).toBe(false)
  })
})

describe("assertValidRedirectRegistration", () => {
  it("accepts https, custom schemes, and the literal loopback address", () => {
    // Native clients need the last three: a mobile app cannot serve https, and RFC 8252 is built
    // on custom schemes and loopback redirects.
    for (const uri of [
      "https://app.example.com/callback",
      "com.example.app:/oauth",
      "http://127.0.0.1:8976/callback",
      "http://[::1]:8976/callback",
    ]) {
      expect(() => {
        assertValidRedirectRegistration(uri)
      }).not.toThrow()
    }
  })

  it("refuses plain http on a named host", () => {
    expect(() => {
      assertValidRedirectRegistration("http://app.example.com/cb")
    }).toThrow(OAuthError)
  })

  it("refuses http://localhost, which resolves through the host's resolver", () => {
    // RFC 8252 §7.3: use the literal address. `localhost` can be influenced by another process
    // on the machine, which is the whole threat a native client's loopback redirect faces.
    expect(() => {
      assertValidRedirectRegistration("http://localhost:8976/cb")
    }).toThrow(OAuthError)
  })

  it("refuses a fragment, which the authorization response cannot survive", () => {
    expect(() => {
      assertValidRedirectRegistration("https://app.example.com/cb#x")
    }).toThrow(OAuthError)
  })

  it("refuses embedded credentials", () => {
    expect(() => {
      assertValidRedirectRegistration("https://user:pw@app.example.com/cb")
    }).toThrow(OAuthError)
  })

  it("refuses something that is not a URL", () => {
    expect(() => {
      assertValidRedirectRegistration("not a url")
    }).toThrow(OAuthError)
  })
})
