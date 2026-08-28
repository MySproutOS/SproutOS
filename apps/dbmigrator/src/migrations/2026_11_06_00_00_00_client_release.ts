import { type Kysely, sql } from "kysely"

/**
 * Verified releases of the SproutOS Android client itself.
 *
 * This is separate from `android_app`: the client is a platform release, not a tenant project.
 * Rows are immutable release facts, and selecting the greatest Android version code avoids a
 * mutable "current" pointer that could move backwards.
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
      sql`package_name = 'com.sproutos.store'`,
    )
    .addCheckConstraint(
      "client_release_version_name_check",
      sql`length(version_name) between 1 and 100`,
    )
    .addCheckConstraint(
      "client_release_version_code_check",
      sql`version_code between 1 and 2100000000`,
    )
    .addCheckConstraint("client_release_apk_size_bytes_check", sql`apk_size_bytes > 0`)
    .addCheckConstraint("client_release_apk_sha256_check", sql`apk_sha256 ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint(
      "client_release_certificate_sha256_check",
      sql`certificate_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint("client_release_apk_object_key_check", sql`length(apk_object_key) > 0`)
    .addCheckConstraint(
      "client_release_apk_object_version_check",
      sql`length(apk_object_version) > 0`,
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
