import { type Kysely, sql } from "kysely"

/**
 * Verified releases of the SproutOS Android client itself.
 *
 * This is deliberately separate from `android_app`: the client is a platform release, not a
 * customer's project, and must never acquire a fake project or entitlement merely to appear on
 * `/download` and in the catalogue's update record. Rows are immutable release facts. Selecting
 * the highest version code makes publishing monotonic without a mutable "current" pointer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("client_release")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("package_name", "text", (col) => col.notNull())
    .addColumn("version_name", "text", (col) => col.notNull())
    .addColumn("version_code", "integer", (col) => col.notNull())
    .addColumn("apk_object_key", "text", (col) => col.notNull())
    .addColumn("apk_object_version", "text", (col) => col.notNull())
    .addColumn("apk_sha256", "text", (col) => col.notNull())
    .addColumn("apk_size_bytes", "bigint", (col) => col.notNull())
    .addColumn("certificate_sha256", "text", (col) => col.notNull())
    .addColumn("required", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("verified_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "client_release_package_name_check",
      sql`package_name = 'me.sproutos.client'`,
    )
    .addCheckConstraint("client_release_version_code_check", sql`version_code > 0`)
    .addCheckConstraint("client_release_apk_size_bytes_check", sql`apk_size_bytes > 0`)
    .addCheckConstraint("client_release_apk_sha256_check", sql`apk_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint(
      "client_release_certificate_sha256_check",
      sql`certificate_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addUniqueConstraint("client_release_package_version_key", ["package_name", "version_code"])
    .addUniqueConstraint("client_release_apk_object_version_key", [
      "apk_object_key",
      "apk_object_version",
    ])
    .execute()

  await db.schema
    .createIndex("client_release_latest_idx")
    .on("client_release")
    .columns(["package_name", "version_code"])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("client_release").execute()
}
