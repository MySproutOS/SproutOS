import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The sign-in flow crosses hosts, and the cookies that carry it have to cross with it.
 *
 * `SHARED_ROUTES` and the marketing pages put a "Sign in with GitHub" link on every host the
 * website serves — the apex included — while the OAuth App has exactly one registered callback
 * URL. On the live deployment those are `selloutjobs.com` and `app.selloutjobs.com`, and the
 * transient cookies were host-only, so the callback saw no state and answered 400 to everyone who
 * started from the front page.
 *
 * The assertion that catches it is not "a domain is set" — it is that the transient cookies are
 * scoped exactly like the session cookie, since the session cookie is the one whose scope is
 * already known to be right. A future change that moves one and not the other fails here.
 */

const cookieJar = new Map<string, { value: string; options: Record<string, unknown> }>()

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      set: (name: string, value: string, options: Record<string, unknown>) => {
        cookieJar.set(name, { value, options })
      },
      get: (name: string) => {
        const entry = cookieJar.get(name)
        return entry === undefined ? undefined : { name, value: entry.value }
      },
      delete: () => {},
    }),
}))

vi.mock("@website/lib/oauth", () => ({
  GITHUB_IDENTITY_SCOPES: ["read:user", "user:email"] as const,
  GITHUB_REPOSITORY_SCOPES: ["read:user", "user:email", "repo", "read:org"] as const,
  generateCodeVerifier: () => "verifier",
  generateState: () => "state",
  githubOAuthClient: () => ({
    createAuthorizationUrl: () =>
      Promise.resolve(new URL("https://github.com/login/oauth/authorize")),
  }),
}))

import { cookieDomain } from "@website/lib/auth"
import { RETURN_TO_COOKIE } from "@website/lib/return-to"
import { GET } from "./route"

const TRANSIENT = ["github_oauth_state", "github_code_verifier", RETURN_TO_COOKIE]

describe("the GitHub sign-in entry point", () => {
  beforeEach(() => {
    cookieJar.clear()
  })

  afterEach(() => {
    delete process.env.SESSION_COOKIE_DOMAIN
    delete process.env.NEXT_PUBLIC_HOST_URL
  })

  it("scopes the transient cookies exactly like the session cookie", async () => {
    process.env.SESSION_COOKIE_DOMAIN = ".selloutjobs.com"
    await GET(new Request("https://selloutjobs.com/login/github?next=%2Fstore"))

    expect(cookieDomain()).toBe(".selloutjobs.com")

    // As a map so a failure names the cookie that is wrong. `expect(value, label)` would be the
    // obvious way to say that and vitest's matcher takes one argument.
    const domains = Object.fromEntries(
      TRANSIENT.map((name) => [name, cookieJar.get(name)?.options.domain]),
    )
    expect(domains).toEqual({
      github_oauth_state: ".selloutjobs.com",
      github_code_verifier: ".selloutjobs.com",
      [RETURN_TO_COOKIE]: ".selloutjobs.com",
    })
  })

  it("leaves them host-only where the session cookie is host-only", async () => {
    process.env.NEXT_PUBLIC_HOST_URL = "http://localhost:3000"
    await GET(new Request("http://localhost:3000/login/github"))

    expect(cookieDomain()).toBeUndefined()
    expect(cookieJar.get("github_oauth_state")?.options.domain).toBeUndefined()
  })

  it("only stores a return-to that stays on this site", async () => {
    process.env.SESSION_COOKIE_DOMAIN = ".selloutjobs.com"
    await GET(new Request("https://selloutjobs.com/login/github?next=%2F%2Fevil.example"))

    expect(cookieJar.has(RETURN_TO_COOKIE)).toBe(false)
  })
})
