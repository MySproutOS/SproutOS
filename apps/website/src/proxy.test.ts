import fs from "node:fs"
import path from "node:path"
import { isRewrite, getRewrittenUrl } from "next/experimental/testing/server"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { proxy } from "./proxy"

vi.mock("./lib/auth", () => ({
  validateSessionToken: vi.fn<typeof validateSessionToken>(),
  // Host-only cookie in dev/test; see the cookieDomain docs in ./lib/auth
  cookieDomain: () => undefined,
}))
import { validateSessionToken } from "./lib/auth"
const mockValidate = vi.mocked(validateSessionToken)

const VALID_SESSION = { session: {}, user: {} } as Awaited<ReturnType<typeof validateSessionToken>>

function makeRequest(urlPath: string, sessionToken?: string) {
  const req = new NextRequest(`https://example.com${urlPath}`)
  if (sessionToken) req.cookies.set("session", sessionToken)
  return req
}

// Copied from next/dist/shared/lib/segment.js — not publicly exported
function isGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")")
}

// Adapted from next/dist/shared/lib/router/utils/app-paths.js normalizeAppPath()
// Strips route groups, parallel slots (@), and leaf page/route segments
function normalizeAppPath(route: string): string {
  return (
    "/" +
    route
      .split("/")
      .filter(Boolean)
      .reduce<string[]>((parts, segment, i, arr) => {
        if (isGroupSegment(segment)) return parts
        if (segment.startsWith("@")) return parts
        if ((segment === "page" || segment === "route") && i === arr.length - 1) return parts
        return [...parts, segment]
      }, [])
      .join("/")
  )
}

/** Scan a route group directory for page.tsx files, return normalized URL paths
 *  (e.g. "/posting/[id]"). Uses the same segment rules as Next.js. */
function discoverRoutePaths(groupDir: string, routePath = ""): string[] {
  const paths: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(groupDir, { withFileTypes: true })
  } catch {
    return paths
  }

  if (entries.some((e) => e.isFile() && /^page\.tsx?$/.test(e.name)) && routePath) {
    paths.push(normalizeAppPath(routePath))
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name === "api" || name.startsWith("_") || name.startsWith("@")) continue
    const nextRoutePath = isGroupSegment(name) ? routePath : `${routePath}/${name}`
    paths.push(...discoverRoutePaths(path.join(groupDir, name), nextRoutePath))
  }
  return paths
}

/** Convert a pattern path to a concrete URL for testing.
 *  Replaces Next.js dynamic segments with sample values. */
function patternToUrl(pattern: string): string {
  return pattern
    .replace(/\[\[\.\.\.(\w+)\]\]/g, "test-a/test-b") // optional catch-all
    .replace(/\[\.\.\.(\w+)\]/g, "test-a/test-b") // required catch-all
    .replace(/\[(\w+)\]/g, "test-value") // [param]
}

const appDir = path.join(__dirname, "app")
const dashboardPages = discoverRoutePaths(path.join(appDir, "(dashboard)"))
const adminPages = discoverRoutePaths(path.join(appDir, "(admin)"))

beforeEach(() => {
  mockValidate.mockReset()
})

describe.each(dashboardPages)("shared dashboard route %s", (pattern) => {
  const url = patternToUrl(pattern)

  it("no session → no rewrite", async () => {
    const res = await proxy(makeRequest(url))
    expect(isRewrite(res)).toBe(false)
  })

  it("valid session → rewrite to dashboard SPA", async () => {
    mockValidate.mockResolvedValueOnce(VALID_SESSION)
    const res = await proxy(makeRequest(url, "tok"))
    expect(isRewrite(res)).toBe(true)
    expect(getRewrittenUrl(res)).toContain("/dashboard")
  })

  it("invalid session → no rewrite", async () => {
    mockValidate.mockResolvedValueOnce(null)
    const res = await proxy(makeRequest(url, "bad"))
    expect(isRewrite(res)).toBe(false)
  })
})

describe.each(adminPages)("shared admin route %s", (pattern) => {
  const url = patternToUrl(pattern)

  it("valid session → rewrite to admin SPA", async () => {
    mockValidate.mockResolvedValueOnce(VALID_SESSION)
    const res = await proxy(makeRequest(url, "tok"))
    expect(isRewrite(res)).toBe(true)
    expect(getRewrittenUrl(res)).toContain("/admin")
  })

  it("no session → redirect to /login", async () => {
    const res = await proxy(makeRequest(url))
    expect(isRewrite(res)).toBe(false)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("invalid session → redirect to /login", async () => {
    mockValidate.mockResolvedValueOnce(null)
    const res = await proxy(makeRequest(url, "bad"))
    expect(isRewrite(res)).toBe(false)
    expect(res.headers.get("location")).toContain("/login")
  })
})

describe("default fallback (non-public, non-shared route)", () => {
  it("no session → redirect to /login", async () => {
    const res = await proxy(makeRequest("/settings"))
    expect(isRewrite(res)).toBe(false)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("valid session → rewrite to dashboard SPA", async () => {
    mockValidate.mockResolvedValueOnce(VALID_SESSION)
    const res = await proxy(makeRequest("/settings", "tok"))
    expect(isRewrite(res)).toBe(true)
    expect(getRewrittenUrl(res)).toContain("/dashboard")
  })

  it("invalid session → redirect to /login", async () => {
    mockValidate.mockResolvedValueOnce(null)
    const res = await proxy(makeRequest("/settings", "bad"))
    expect(isRewrite(res)).toBe(false)
    expect(res.headers.get("location")).toContain("/login")
  })
})

describe("adding a new page to (dashboard) without updating SHARED_ROUTES", () => {
  const testPageDir = path.join(appDir, "(dashboard)", "test-unregistered")
  const testPageFile = path.join(testPageDir, "page.tsx")

  beforeAll(() => {
    fs.mkdirSync(testPageDir, { recursive: true })
    fs.writeFileSync(
      testPageFile,
      "export default function TestPage() { return <div>test</div> }\n",
    )
  })

  afterAll(() => {
    fs.rmSync(testPageDir, { recursive: true })
  })

  it("filesystem scan discovers the new route", () => {
    const routes = discoverRoutePaths(path.join(appDir, "(dashboard)"))
    expect(routes).toContain("/test-unregistered")
  })

  it("unauthenticated request redirects to /login", async () => {
    const res = await proxy(makeRequest("/test-unregistered"))
    expect(isRewrite(res)).toBe(false)
    expect(res.headers.get("location")).toContain("/login")
  })
})
