import { afterEach, describe, expect, it, vi } from "vitest"
import { generateCodeVerifier, generateState } from "./client"
import {
  fetchGitHubUser,
  GITHUB_IDENTITY_SCOPES,
  GITHUB_REPOSITORY_SCOPES,
  githubOAuthClient,
} from "./github"

const ENV = {
  GITHUB_OAUTH_CLIENT_ID: "Iv1.test",
  GITHUB_OAUTH_CLIENT_SECRET: "shh",
  NEXT_PUBLIC_HOST_URL: "http://localhost:3000",
}

function withEnv<T>(fn: () => T): T {
  const saved = { ...process.env }
  Object.assign(process.env, ENV)
  try {
    return fn()
  } finally {
    process.env = saved
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("scopes", () => {
  it("asks for identity only at sign-in", () => {
    // Requesting `repo` at the front door would make every visitor grant blanket
    // access to their private repositories just to see a dashboard.
    expect(GITHUB_IDENTITY_SCOPES).toEqual(["read:user", "user:email"])
    expect(GITHUB_IDENTITY_SCOPES).not.toContain("repo")
  })

  it("escalates to repository access separately", () => {
    expect(GITHUB_REPOSITORY_SCOPES).toContain("repo")
  })
})

describe("generators", () => {
  it("produces a PKCE verifier of the length RFC 7636 requires", () => {
    // 43-128 unreserved characters; 32 bytes of base64url is exactly 43.
    expect(generateCodeVerifier()).toHaveLength(43)
  })

  it("produces unguessable, non-repeating state", () => {
    const values = new Set(Array.from({ length: 64 }, () => generateState()))
    expect(values.size).toBe(64)
  })
})

describe("githubOAuthClient", () => {
  it("fails loudly on a missing variable rather than building a broken client", () => {
    const saved = process.env.GITHUB_OAUTH_CLIENT_ID
    delete process.env.GITHUB_OAUTH_CLIENT_ID
    try {
      expect(() => githubOAuthClient()).toThrow(/GITHUB_OAUTH_CLIENT_ID/)
    } finally {
      if (saved !== undefined) process.env.GITHUB_OAUTH_CLIENT_ID = saved
    }
  })

  it("builds an authorization URL carrying PKCE", async () => {
    const url = await withEnv(() =>
      githubOAuthClient().createAuthorizationUrl("state-123", generateCodeVerifier(), [
        ...GITHUB_IDENTITY_SCOPES,
      ]),
    )

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("state")).toBe("state-123")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/login/github/callback")
    expect(url.searchParams.get("scope")).toBe("read:user user:email")
    // GitHub documents code_challenge/S256 on this endpoint, so this is real
    // protection rather than a parameter it ignores.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("fetchGitHubUser", () => {
  it("uses the numeric id, not the login, as the stable identifier", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: 1234,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://example.test/a.png",
        email: "octo@example.test",
      }),
    )

    const user = await fetchGitHubUser("gho_x")
    // A login can be renamed and reused by someone else; the id cannot.
    expect(user.id).toBe("1234")
    expect(user.login).toBe("octocat")
    expect(user.email).toBe("octo@example.test")
  })

  it("falls back to the emails endpoint when the profile address is private", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: 7, login: "ghost", name: null, email: null }))
      .mockResolvedValueOnce(
        jsonResponse([
          { email: "old@example.test", primary: false, verified: true },
          { email: "primary@example.test", primary: true, verified: true },
        ]),
      )

    const user = await fetchGitHubUser("gho_x")
    expect(user.email).toBe("primary@example.test")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("refuses an unverified address", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: 7, login: "ghost", email: null }))
      .mockResolvedValueOnce(
        jsonResponse([{ email: "unverified@example.test", primary: true, verified: false }]),
      )

    // An unverified address proves nothing about who controls it.
    await expect(fetchGitHubUser("gho_x")).rejects.toThrow(/verified email/)
  })

  it("rejects a profile with no id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ login: "ghost" }))
    await expect(fetchGitHubUser("gho_x")).rejects.toThrow(/'id'/)
  })

  it("surfaces an API error rather than returning a half-built user", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "Bad credentials" }, 401),
    )
    await expect(fetchGitHubUser("gho_bad")).rejects.toThrow(/GitHub API returned an error/)
  })
})
