import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * When a listing was last built, and what happened.
 *
 * The store's promise is that a listed application deploys, and nothing checked it. The catalogue
 * broke that promise three different ways in one afternoon — a Dockerfile that is not at the root,
 * a framework monorepo listed as a blog starter, and a Dockerfile that is real and expects a
 * release artifact (`COPY dist/shiori…`) no fork of the source has. Every one was invisible to
 * inspection: the repository exists, the path exists, the file is a valid Dockerfile. Every one was
 * found by a customer-shaped action failing.
 *
 * `last_verified_at` is "when we last looked", not "when it last worked" — it moves whether the
 * build passed or failed, because leaving it unset on failure would make a permanently broken
 * listing the only thing the check ever looks at.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table store_listing
      add column last_verified_at timestamptz,
      add column verification_error text
  `.execute(db)

  // The check reads this ordering directly: never-verified first, then oldest. Without it every
  // run is a sequential scan of the whole catalogue to find three rows.
  await sql`
    create index store_listing_verification_idx
      on store_listing (last_verified_at nulls first)
      where status = 'published' and deleted_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists store_listing_verification_idx`.execute(db)
  await sql`alter table store_listing drop column verification_error, drop column last_verified_at`.execute(
    db,
  )
}
