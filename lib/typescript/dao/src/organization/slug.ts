// The uniqueness probe is a read-modify-write chain: candidate N+1 is only asked about when N
// was taken, so the awaits stay serial.
/* oxlint-disable no-await-in-loop */
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * Slugs that must never belong to an organization.
 *
 * ADR 0003 puts organizations behind an explicit `/orgs/` prefix, so none of these actually
 * collide with a top-level route any more. They stay reserved because they read as system paths
 * to a user, and because `/orgs/new` is the natural URL for a create form that a team called
 * "new" would otherwise shadow.
 */
export const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  "about",
  "admin",
  "api",
  "assets",
  "billing",
  "blog",
  "dashboard",
  "docs",
  "help",
  "internal",
  "invites",
  "legal",
  "login",
  "logout",
  "me",
  "new",
  "orgs",
  "pricing",
  "public",
  "root",
  "settings",
  "signin",
  "signup",
  "static",
  "store",
  "support",
  "system",
])

const MIN_SLUG_LENGTH = 2
const MAX_SLUG_LENGTH = 48
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidOrganizationSlug(slug: string): boolean {
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) return false
  if (RESERVED_ORGANIZATION_SLUGS.has(slug)) return false
  return SLUG_PATTERN.test(slug)
}

/**
 * Derives a candidate slug from a display name.
 *
 * Diacritics are folded rather than dropped so "Café Team" becomes `cafe-team` instead of
 * `caf-team`. Anything left that is not `[a-z0-9]` becomes a single hyphen, and a name that
 * reduces to nothing at all — an all-emoji team name — falls back to `team` for the caller's
 * uniqueness loop to disambiguate.
 */
export function slugifyOrganizationName(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")

  return folded.length >= MIN_SLUG_LENGTH ? folded : "team"
}

/**
 * Finds a free slug near `desired`, appending `-2`, `-3`, … until one is unused.
 *
 * The uniqueness index is partial (`WHERE deleted_at IS NULL`), so a soft-deleted organization
 * releases its slug and this must query with the same predicate or it would refuse a name that
 * the database would happily accept. The loop is advisory: the insert can still race and hit the
 * index, which is the authoritative check.
 */
export async function allocateOrganizationSlug(db: Kysely<DB>, desired: string): Promise<string> {
  const base = isValidOrganizationSlug(desired) ? desired : slugifyOrganizationName(desired)

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 40)}-${attempt}`
    if (!isValidOrganizationSlug(candidate)) continue

    const taken = await db
      .selectFrom("organization")
      .select("id")
      .where("slug", "=", candidate)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (!taken) return candidate
  }

  return `${base.slice(0, 30)}-${Math.random().toString(36).slice(2, 10)}`
}
