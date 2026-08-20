// The uniqueness probe is a read-modify-write chain: candidate N+1 is only asked about when N was
// taken, so the awaits stay serial.
/* oxlint-disable no-await-in-loop */
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

const MIN_SLUG_LENGTH = 1
const MAX_SLUG_LENGTH = 63
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Project slugs carry no reserved-word list.
 *
 * They live under `/orgs/:orgSlug/projects/:slug` rather than at a path root, so there is nothing
 * for them to shadow. They are still constrained to hyphenated lowercase because the slug ends up
 * in a Knative service name and a preview hostname, neither of which accepts anything else.
 */
export function isValidProjectSlug(slug: string): boolean {
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) return false
  return SLUG_PATTERN.test(slug)
}

export function slugifyProjectName(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")

  return folded.length >= MIN_SLUG_LENGTH ? folded : "project"
}

/**
 * Finds a free slug near `desired` within one organization.
 *
 * The index is partial on `deleted_at IS NULL`, so a soft-deleted project releases its name and
 * this must query with the same predicate — otherwise it would refuse a slug the database would
 * accept. Advisory only: the insert can still race, and the index is the authority.
 */
export async function allocateProjectSlug(
  db: Kysely<DB>,
  organizationId: string,
  desired: string,
): Promise<string> {
  const base = isValidProjectSlug(desired) ? desired : slugifyProjectName(desired)

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 48)}-${attempt}`
    if (!isValidProjectSlug(candidate)) continue

    const taken = await db
      .selectFrom("project")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("slug", "=", candidate)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (!taken) return candidate
  }

  return `${base.slice(0, 40)}-${Math.random().toString(36).slice(2, 10)}`
}
