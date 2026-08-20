import type { Context } from "hono"

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const IPV6 = /^[0-9a-f:]+$/i

/**
 * The request-level fields of an `audit_log` row: who was really at the keyboard, and from where.
 *
 * `audit_log.ip` is `inet`, so anything that is not plausibly an address is dropped rather than
 * handed to the driver — a spoofed `X-Forwarded-For` should cost us a null column, not a failed
 * transaction that also rolls back the mutation being audited.
 *
 * `impersonatorUserId` is here, in the helper every audited route already spreads, rather than
 * being something each route remembers to add. That is the whole reason impersonation mints a
 * session for the target user instead of flagging the admin's own: the identity downstream is
 * ordinary, so no route needs changing, and there is no route left that can forget.
 */
export function auditContext(c: Context): {
  ip: string | null
  userAgent: string | null
  impersonatorUserId: string | null
} {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
  const candidate = forwarded ?? c.req.header("x-real-ip") ?? null
  const ip =
    candidate !== null && candidate !== "" && (IPV4.test(candidate) || IPV6.test(candidate))
      ? candidate
      : null

  // Optional chaining because this helper is also reached from unauthenticated routes — the OAuth
  // token endpoint audits without a session — where there is no impersonation to record.
  const session = (c.var as { session?: { impersonatedByUserId: string | null } | null }).session

  return {
    ip,
    userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
    impersonatorUserId: session?.impersonatedByUserId ?? null,
  }
}
