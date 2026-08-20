import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { cookieDomain, validateSessionToken } from "./lib/auth"

/** Public paths handled by Next.js — everything else goes to the dashboard SPA.
 *  Note there is no "/api" here: the Hono API is a separate deployment on its own host. */
const NEXTJS_PUBLIC_PREFIXES = ["/login", "/blog", "/legal"]

/** Exact public paths */
const NEXTJS_PUBLIC_EXACT = new Set(["/"])

type SharedRoute = { path: string; spa: "dashboard" | "admin" }

/** Routes that serve Next.js for unauthenticated users, SPA for authenticated users.
 *  Paths use Next.js conventions: [param], [...catchAll], [[...optionalCatchAll]] */
const SHARED_ROUTES: SharedRoute[] = [
  { path: "/posting", spa: "dashboard" },
  { path: "/posting/[id]", spa: "dashboard" },
]

/** Match a URL pathname against a route pattern.
 *  - Static segments: exact match
 *  - [param]: matches exactly one segment
 *  - [...catchAll]: matches one or more segments (must be last)
 *  - [[...optionalCatchAll]]: matches zero or more segments (must be last)
 */
function matchRoute(pattern: string, pathname: string): boolean {
  const patternSegs = pattern.split("/").filter(Boolean)
  const pathSegs = pathname.split("/").filter(Boolean)

  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i]

    if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      return true
    }

    if (seg.startsWith("[...") && seg.endsWith("]")) {
      return pathSegs.length > i
    }

    if (seg.startsWith("[") && seg.endsWith("]")) {
      if (i >= pathSegs.length) return false
      continue
    }

    if (i >= pathSegs.length || pathSegs[i] !== seg) return false
  }

  return pathSegs.length === patternSegs.length
}

function findSharedRoute(pathname: string): SharedRoute | undefined {
  return SHARED_ROUTES.find((r) => matchRoute(r.path, pathname))
}

const SPA_ADMIN = {
  prefix: "/admin",
  devPort: 3003,
} as const

const DASHBOARD_DEV_PORT = 3002

function isNextJsRoute(pathname: string): boolean {
  if (NEXTJS_PUBLIC_EXACT.has(pathname)) return true
  return NEXTJS_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function isAssetRequest(pathname: string): boolean {
  if (/\.\w+$/.test(pathname)) return true
  // Vite dev server internal paths
  if (/@vite|@react-refresh|@id|node_modules\/\.vite/.test(pathname)) return true
  return false
}

function handleCsrfAndCookies(request: NextRequest): NextResponse | null {
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-pathname", request.nextUrl.pathname)

  if (request.method === "GET") {
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    const token = request.cookies.get("session")?.value ?? null
    if (token !== null) {
      response.cookies.set("session", token, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        // Unset in dev; in prod scopes the cookie to the parent domain so the API host gets it.
        domain: cookieDomain(),
      })
    }
    return response
  }

  const originHeader = request.headers.get("Origin")
  const hostHeader = request.headers.get("X-Forwarded-Host") ?? request.headers.get("Host")
  if (originHeader === null || hostHeader === null) {
    return new NextResponse(null, { status: 403, headers: requestHeaders })
  }
  let origin: URL
  try {
    origin = new URL(originHeader)
  } catch {
    return new NextResponse(null, { status: 403, headers: requestHeaders })
  }
  if (origin.host !== hostHeader) {
    return new NextResponse(null, { status: 403, headers: requestHeaders })
  }

  return null
}

function rewriteToSpa(
  request: NextRequest,
  pathname: string,
  devPort: number,
  devBasePath: string,
  prodFolder: string,
): NextResponse {
  const isDev = process.env.NODE_ENV === "development"
  const spaOrigin = isDev ? `http://localhost:${devPort}` : "https://d1i66hf38xpie.cloudfront.net"

  const spaUrl = new URL(pathname, spaOrigin)
  spaUrl.search = request.nextUrl.search

  if (!isAssetRequest(pathname)) {
    if (isDev) {
      spaUrl.pathname = `${devBasePath}/`
    } else {
      spaUrl.pathname = `${prodFolder}/index.html`
    }
  }

  return NextResponse.rewrite(spaUrl)
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Shared routes — check auth, rewrite to SPA or fall through to Next.js
  const sharedRoute = findSharedRoute(pathname)
  if (sharedRoute) {
    const token = request.cookies.get("session")?.value ?? null
    if (token !== null) {
      const result = await validateSessionToken(token)
      if (result !== null) {
        if (sharedRoute.spa === "admin") {
          return rewriteToSpa(request, pathname, SPA_ADMIN.devPort, "/admin", "/admin")
        }
        return rewriteToSpa(request, pathname, DASHBOARD_DEV_PORT, "", "/dashboard")
      }
    }
    // No valid session → serve Next.js SSR page
    const csrfResult = handleCsrfAndCookies(request)
    if (csrfResult) return csrfResult
    return NextResponse.next()
  }

  // Next.js public routes — pass through with CSRF/cookie handling
  if (isNextJsRoute(pathname)) {
    const csrfResult = handleCsrfAndCookies(request)
    if (csrfResult) return csrfResult
    return NextResponse.next()
  }

  // Admin SPA — requires auth
  if (pathname === SPA_ADMIN.prefix || pathname.startsWith(`${SPA_ADMIN.prefix}/`)) {
    const token = request.cookies.get("session")?.value ?? null
    if (token !== null) {
      const result = await validateSessionToken(token)
      if (result !== null) {
        return rewriteToSpa(request, pathname, SPA_ADMIN.devPort, "/admin", "/admin")
      }
    }
    return NextResponse.redirect(new URL("/login", request.url))
  }

  // Everything else → Dashboard SPA if authenticated, otherwise redirect to login
  const token = request.cookies.get("session")?.value ?? null
  if (token !== null) {
    const result = await validateSessionToken(token)
    if (result !== null) {
      return rewriteToSpa(request, pathname, DASHBOARD_DEV_PORT, "", "/dashboard")
    }
  }
  return NextResponse.redirect(new URL("/login", request.url))
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\..*).*)"],
}
