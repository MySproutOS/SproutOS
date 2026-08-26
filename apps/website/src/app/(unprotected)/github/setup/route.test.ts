import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Who is allowed to attach a GitHub App installation to an organization.
 *
 * The route takes an `installation_id` out of a query string, which means an id is a small integer
 * a stranger can guess. The only thing standing between that and one customer's organization
 * holding a token for another customer's repositories is the `GET /user/installations` check, so
 * that is what these assert — not the happy path, which is the case that gets exercised by hand
 * anyway.
 */

const cookieJar = new Map<string, string>()

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieJar.get(name)
        return value === undefined ? undefined : { name, value }
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value)
      },
      delete: (name: string) => {
        cookieJar.delete(name)
      },
    }),
}))

const session = { value: null as { user: { id: string } } | null }
vi.mock("@website/lib/auth", () => ({
  getCurrentSession: () => Promise.resolve(session.value),
  cookieDomain: () => undefined,
}))

const linked = vi.fn<(...args: unknown[]) => void>()
const installations = { value: [] as { id: number; account: { login: string; type: string } }[] }
const credential = { value: undefined as { kind: string; token: string } | undefined }

vi.mock("@lib/github", () => ({
  createGitHubClient: () => ({
    request: () => Promise.resolve({ data: { installations: installations.value } }),
  }),
  linkInstallation: (...args: unknown[]) => {
    linked(...args)
    return Promise.resolve()
  },
  userGitHubIdentity: () => Promise.resolve(credential.value),
}))

vi.mock("@lib/dao", () => ({
  fetchOrganization: () => ({ getBySlug: () => Promise.resolve({ id: "org-1" }) }),
}))

vi.mock("@sproutos/db", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: function () {
          return this
        },
        executeTakeFirst: () => Promise.resolve(membership.value),
      }),
    }),
  },
}))

const membership = { value: undefined as { id: string } | undefined }

import { GET } from "./route"

function outcome(response: Response): string {
  return (
    new URL(response.headers.get("Location") ?? "", "https://x").searchParams.get("install") ?? ""
  )
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_HOST_URL = "https://sproutos.me"
  cookieJar.clear()
  cookieJar.set("github_install_org", "acme")
  session.value = { user: { id: "user-1" } }
  membership.value = { id: "member-1" }
  credential.value = { kind: "user", token: "gho_x" }
  installations.value = [{ id: 42, account: { login: "acme", type: "Organization" } }]
  linked.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("the GitHub App setup callback", () => {
  it("links an installation the caller can administer", async () => {
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
    )
    expect(outcome(response)).toBe("installed")
    expect(linked).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ id: 42, login: "acme", accountType: "Organization" }),
    )
  })

  /*
    The one that matters. GitHub is the authority on which installations a person administers, so an
    id that is not in their list is somebody else's — and guessing one is a matter of counting.
  */
  it("refuses an installation GitHub does not list for this user", async () => {
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=999&setup_action=install"),
    )
    expect(outcome(response)).toBe("forbidden")
    expect(linked).not.toHaveBeenCalled()
  })

  it("refuses a caller who is not a member of the organization that asked", async () => {
    membership.value = undefined
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
    )
    expect(outcome(response)).toBe("forbidden")
    expect(linked).not.toHaveBeenCalled()
  })

  it("sends an unauthenticated caller to sign in rather than losing the installation", async () => {
    session.value = null
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
    )
    const location = response.headers.get("Location") ?? ""
    expect(location).toContain("/login?next=")
    // The whole callback URL, because GitHub sends `installation_id` exactly once.
    expect(decodeURIComponent(location)).toContain("installation_id=42")
    expect(linked).not.toHaveBeenCalled()
  })

  /*
    An organization that requires owner approval sends the user back with no installation at all.
    Reporting that as a failure blames somebody who did everything right.
  */
  it("distinguishes an approval request from a failure", async () => {
    const response = await GET(new Request("https://sproutos.me/github/setup?setup_action=request"))
    expect(outcome(response)).toBe("requested")
    expect(linked).not.toHaveBeenCalled()
  })

  /*
    A cookie that outlives a failed attempt steers the next one. Installing for `acme`, failing, and
    then installing for `beta` must not attach `beta`'s installation to `acme`.
  */
  it("consumes the organization cookie even when nothing is linked", async () => {
    await GET(new Request("https://sproutos.me/github/setup?installation_id=999"))
    expect(cookieJar.has("github_install_org")).toBe(false)
  })
})
