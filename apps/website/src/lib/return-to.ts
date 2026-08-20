/**
 * Where to send someone after they sign in.
 *
 * The value arrives as a query parameter on a link anyone can craft, so it is an open-redirect
 * hole unless it is constrained to a path on this site. A single leading slash is required and a
 * second one is refused: `//evil.example` is a protocol-relative URL that browsers happily follow
 * off-site, and it passes a naive `startsWith("/")` check. `\` is refused for the same reason —
 * some browsers normalize it to `/`.
 */
export function sanitizeReturnTo(value: string | null): string | null {
  if (value === null || value === "") return null
  if (!value.startsWith("/")) return null
  if (value.startsWith("//") || value.startsWith("/\\")) return null
  return value
}

export const RETURN_TO_COOKIE = "post_login_return_to"
