import type { Kysely } from "kysely"

/**
 * Keep the retired tag columns through the rolling-deployment compatibility window.
 *
 * The cadence migration stops reading and writing them, but the previous worker selects
 * `upstream_tag_checked_at` during an upkeep scan. A migration runs before replacement tasks are
 * proven healthy, so dropping the columns in the same release makes rollback restore code that can
 * no longer scan. Nullable dormant columns are cheap; removing them belongs in a later release.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("repository")
    .addColumn("upstream_tag_fingerprint", "text")
    .addColumn("upstream_tag_checked_at", "timestamptz")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("repository").dropColumn("upstream_tag_checked_at").execute()
  await db.schema.alterTable("repository").dropColumn("upstream_tag_fingerprint").execute()
}
