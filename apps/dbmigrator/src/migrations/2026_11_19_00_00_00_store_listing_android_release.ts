import { type Kysely, sql } from "kysely"

/**
 * The Android app explicitly published by a store listing.
 *
 * `project.store_listing_id` is template provenance: every customer fork keeps it. It must never
 * double as anonymous APK publication. This nullable association is the separate editorial act
 * that makes one verified Android identity the listing's canonical public release.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("store_listing")
    .addColumn("canonical_android_app_id", "uuid", (column) =>
      column.references("android_app.id").onDelete("set null").unique(),
    )
    .execute()
  await db.schema
    .alterTable("store_listing")
    .addCheckConstraint(
      "store_listing_canonical_android_platform_check",
      sql`canonical_android_app_id is null or platform = 'android'`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("store_listing")
    .dropConstraint("store_listing_canonical_android_platform_check")
    .execute()
  await db.schema.alterTable("store_listing").dropColumn("canonical_android_app_id").execute()
}
