/**
 * The star count for our own repository.
 *
 * Fetched server-side rather than through the `ghbtns.com` iframe embed, for three reasons: the
 * iframe renders GitHub's own button styling, which is a foreign object on a dark-only page; it
 * adds a third-party frame to every page load; and it cannot be given our type or our tokens.
 * The number is the same number.
 *
 * Unauthenticated, because the repository is public and an anonymous read needs no credential —
 * the rate limit is 60/hour per IP, and `revalidate` keeps us far under it.
 *
 * Returns `null` rather than throwing or defaulting to zero: GitHub being unreachable is not the
 * same fact as "nobody has starred it", and the caller renders the button without a number instead
 * of asserting something false.
 */
const REPOSITORY = "MySproutOS/SproutOS"

export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`

/** An hour. Long enough that a burst of traffic is one request, short enough to feel live. */
const REVALIDATE_SECONDS = 3600

export async function repositoryStars(): Promise<number | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: REVALIDATE_SECONDS },
    })
    if (!response.ok) return null

    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) return null
    const count: unknown = (body as Record<string, unknown>).stargazers_count
    return typeof count === "number" && Number.isFinite(count) ? count : null
  } catch {
    // A marketing page must render whether or not GitHub is up.
    return null
  }
}
