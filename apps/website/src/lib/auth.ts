import { type AuthSession, authUser } from "@lib/dao/user/auth"
import { type DB, db } from "@sproutos/db"
import {
  encodeHexLowerCase,
  generateSessionToken as randomSessionToken,
  sha256Utf8,
} from "@utils/crypto"
import type { Selectable } from "kysely"
import { cookies } from "next/headers"
import { cache } from "react"

/** Cookie `Domain` for the session cookie, derived from NEXT_PUBLIC_HOST_URL as `.example.com`.
 *
 *  Deliberately undefined for local hosts: the website (:3000) and the API (:3001) share the
 *  `localhost` host, and cookies ignore ports, so a host-only cookie already reaches both.
 *  In production they live on different hosts (`example.com` and `api.example.com`), so the
 *  cookie needs the parent domain — with the leading dot — to be sent to the API.
 *
 *  A function rather than a constant, mirroring apps/internal-api/src/utils/env.ts, which must
 *  read lazily because dotenv has not run when that module is evaluated. */
export function cookieDomain(): string | undefined {
  const hostUrl = process.env.NEXT_PUBLIC_HOST_URL
  if (hostUrl === undefined || hostUrl === "") return undefined
  const { hostname } = new URL(hostUrl)
  if (hostname === "localhost" || hostname === "127.0.0.1") return undefined
  return `.${hostname}`
}

export function generateSessionToken(): string {
  return randomSessionToken()
}

/** The session table stores the hash, never the token, so a database leak yields nothing
 *  replayable as a cookie. */
async function toSessionKey(token: string): Promise<string> {
  return encodeHexLowerCase(await sha256Utf8(token))
}

export async function createSession(token: string, userId: string): Promise<AuthSession> {
  const sessionKey = await toSessionKey(token)
  const newSession = {
    sessionKey,
    userId,
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    // Signing in is never impersonation. Impersonated sessions are minted by
    // `impersonation().start`, which is the only place that sets this.
    impersonatedByUserId: null,
  }
  await db.insertInto("session").values(newSession).executeTakeFirstOrThrow()
  return newSession
}

export type SessionUser = Pick<Selectable<DB["user"]>, "id" | "isAdmin" | "name" | "email">

export type SessionValidationResult = {
  session: AuthSession
  user: SessionUser
} | null

export async function validateSessionToken(token: string): Promise<SessionValidationResult> {
  return await authUser(db).validateSessionToken(await toSessionKey(token))
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.deleteFrom("session").where("sessionKey", "=", sessionId).execute()
}

export async function setSessionTokenCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
    domain: cookieDomain(),
  })
}

export async function deleteSessionTokenCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set("session", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
    domain: cookieDomain(),
  })
}

export const getCurrentSession = cache(async (): Promise<SessionValidationResult> => {
  const cookieStore = await cookies()
  const token = cookieStore.get("session")?.value ?? null
  if (token === null) return null
  return await validateSessionToken(token)
})
