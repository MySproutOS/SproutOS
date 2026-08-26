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

/** What `GET /app/installations/{id}` will answer, or `undefined` to make it 404. */
const installation = {
  value: undefined as
    | { id: number; account: { id: number; login: string; type: string } }
    | undefined,
}
/** Whether `GET /user/memberships/orgs/{org}` succeeds. */
const orgMembership = { value: true }
const credential = { value: undefined as { kind: string; token: string } | undefined }

vi.mock("@lib/github", () => ({
  appJwt: (token: string) => ({ kind: "app", token }),
  envAppJwtSigner: () => () => "signed.app.jwt",
  createGitHubClient: () => ({
    request: ({ path }: { path: string }) => {
      if (path.startsWith("/app/installations/")) {
        if (installation.value === undefined) return Promise.reject(new Error("404"))
        return Promise.resolve({ data: installation.value })
      }
      if (path.startsWith("/user/memberships/orgs/")) {
        return orgMembership.value
          ? Promise.resolve({ data: {} })
          : Promise.reject(new Error("403"))
      }
      return Promise.reject(new Error(`unexpected path ${path}`))
    },
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
    selectFrom: (table: string) => ({
      select: () => ({
        where: function () {
          return this
        },
        executeTakeFirst: () =>
          Promise.resolve(table === "account" ? githubAccount.value : membership.value),
      }),
    }),
  },
}))

const membership = { value: undefined as { id: string } | undefined }
/** The caller's linked GitHub identity, as `account.provider_account_id` holds it. */
const githubAccount = { value: undefined as { providerAccountId: string } | undefined }

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
  installation.value = { id: 42, account: { id: 777, login: "acme", type: "Organization" } }
  orgMembership.value = true
  githubAccount.value = { providerAccountId: "777" }
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
  it("refuses an installation GitHub does not know about", async () => {
    installation.value = undefined
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=999&setup_action=install"),
    )
    expect(outcome(response)).toBe("forbidden")
    expect(linked).not.toHaveBeenCalled()
  })

  it("refuses an organization installation the caller does not belong to", async () => {
    orgMembership.value = false
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
    )
    expect(outcome(response)).toBe("orgscope")
    expect(linked).not.toHaveBeenCalled()
  })

  it("links a personal installation to the account that owns it", async () => {
    installation.value = { id: 42, account: { id: 777, login: "andrew", type: "User" } }
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
    )
    expect(outcome(response)).toBe("installed")
    expect(linked).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ accountType: "User", login: "andrew" }),
    )
  })

  /*
    A login can be given up and taken by somebody else, so the claim is checked on GitHub's numeric
    id. Same login, different account, must not link.
  */
  it("refuses a personal installation belonging to a different GitHub account", async () => {
    installation.value = { id: 42, account: { id: 999, login: "andrew", type: "User" } }
    const response = await GET(
      new Request("https://sproutos.me/github/setup?installation_id=42&setup_action=install"),
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
    /*
      On the instance's own address, which is what the request looks like here.

      Next.js sits behind the load balancer, so `request.url` is the internal origin and not the one
      the browser typed. Building this Request on `sproutos.me` would test a situation that never
      occurs in production and pass against the bug.
    */
    const response = await GET(
      new Request("https://0.0.0.0:8080/github/setup?installation_id=42&setup_action=install"),
    )
    const location = response.headers.get("Location") ?? ""
    expect(location).toContain("/login?next=")
    // The whole callback URL, because GitHub sends `installation_id` exactly once.
    const next = decodeURIComponent(location.split("next=")[1] ?? "")
    expect(next).toContain("installation_id=42")
    /*
      On the public host. Behind the load balancer `request.url` names the instance
      (`https://0.0.0.0:8080/...`), and sending somebody there after they sign in loses the
      installation for good.
    */
    expect(next.startsWith("https://sproutos.me/github/setup")).toBe(true)
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
