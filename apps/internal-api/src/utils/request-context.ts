import type { Context } from "hono"

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const IPV6 = /^[0-9a-f:]+$/i

/**
 * The client address and user agent for an `audit_log` row.
 *
 * `audit_log.ip` is `inet`, so anything that is not plausibly an address is dropped rather than
 * handed to the driver — a spoofed `X-Forwarded-For` should cost us a null column, not a failed
 * transaction that also rolls back the mutation being audited.
 */
export function auditContext(c: Context): { ip: string | null; userAgent: string | null } {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
  const candidate = forwarded ?? c.req.header("x-real-ip") ?? null
  const ip =
    candidate !== null && candidate !== "" && (IPV4.test(candidate) || IPV6.test(candidate))
      ? candidate
      : null

  return { ip, userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null }
}
