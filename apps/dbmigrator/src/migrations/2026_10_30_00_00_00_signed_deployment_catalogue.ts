import type { Kysely } from "kysely"
import { sql } from "kysely"

/** Durable, fail-closed provenance for the signed Deployment-Templates catalogue. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table store_listing drop constraint store_listing_tagline_check`.execute(db)
  await sql`
    alter table store_listing add constraint store_listing_tagline_check check (length(tagline) <= 240)
  `.execute(db)

  await db.schema
    .createTable("deployment_catalogue_import")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("oci_repository", "text", (col) => col.notNull())
    .addColumn("oci_digest", "text", (col) => col.notNull())
    .addColumn("catalogue_digest", "text", (col) => col.notNull())
    .addColumn("source_repository", "text", (col) => col.notNull())
    .addColumn("workflow_ref", "text", (col) => col.notNull())
    .addColumn("source_ref", "text", (col) => col.notNull())
    .addColumn("source_sha", "text", (col) => col.notNull())
    .addColumn("signature_identity", "text", (col) => col.notNull())
    .addColumn("signature_issuer", "text", (col) => col.notNull())
    .addColumn("provenance", "jsonb", (col) => col.notNull())
    .addColumn("imported_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("last_reconciled_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("deployment_catalogue_import_oci_digest_key", [
      "oci_repository",
      "oci_digest",
    ])
    .addCheckConstraint(
      "deployment_catalogue_import_oci_digest_check",
      sql`oci_digest ~ '^sha256:[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "deployment_catalogue_import_catalogue_digest_check",
      sql`catalogue_digest ~ '^sha256:[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "deployment_catalogue_import_source_sha_check",
      sql`source_sha ~ '^[0-9a-f]{40}$'`,
    )
    .execute()

  await db.schema
    .alterTable("store_listing")
    .addColumn("catalogue_entry_id", "text")
    .addColumn("catalogue_import_id", "uuid", (col) =>
      col.references("deployment_catalogue_import.id").onDelete("restrict"),
    )
    .addColumn("catalogue_schema_version", "integer")
    .addColumn("catalogue_manifest", "jsonb")
    .addColumn("upstream_commit", "text")
    .addColumn("template_plugin_repository", "text")
    .addColumn("template_plugin_digest", "text")
    .addColumn("required_capabilities", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("capability_readiness", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("catalogue_archived_at", "timestamptz")
    .addColumn("capability_verified_at", "timestamptz")
    .addColumn("e2e_verified_at", "timestamptz")
    .execute()

  await sql`
    update store_listing set status = 'archived', updated_at = now()
    where deleted_at is null and status <> 'archived'
  `.execute(db)

  await sql`
    alter table store_listing add constraint store_listing_catalogue_complete_check check (
      catalogue_entry_id is null or (
        catalogue_import_id is not null
        and catalogue_schema_version is not null
        and catalogue_manifest is not null
        and upstream_commit ~ '^[0-9a-f]{40}$'
        and template_plugin_repository is not null
        and template_plugin_digest ~ '^sha256:[0-9a-f]{64}$'
      )
    )
  `.execute(db)
  await sql`
    alter table store_listing add constraint store_listing_catalogue_publication_check check (
      status <> 'published' or (
        catalogue_entry_id is not null
        and catalogue_archived_at is null
        and capability_verified_at is not null
        and e2e_verified_at is not null
      )
    )
  `.execute(db)

  await sql`
    create unique index store_listing_catalogue_entry_live_key
      on store_listing (catalogue_entry_id) where catalogue_entry_id is not null and deleted_at is null
  `.execute(db)
  await sql`
    create index store_listing_catalogue_import_idx
      on store_listing (catalogue_import_id) where catalogue_import_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists store_listing_catalogue_import_idx`.execute(db)
  await sql`drop index if exists store_listing_catalogue_entry_live_key`.execute(db)
  await sql`alter table store_listing drop constraint store_listing_catalogue_publication_check`.execute(
    db,
  )
  await sql`alter table store_listing drop constraint store_listing_catalogue_complete_check`.execute(
    db,
  )
  await db.schema
    .alterTable("store_listing")
    .dropColumn("e2e_verified_at")
    .dropColumn("capability_verified_at")
    .dropColumn("catalogue_archived_at")
    .dropColumn("capability_readiness")
    .dropColumn("required_capabilities")
    .dropColumn("template_plugin_digest")
    .dropColumn("template_plugin_repository")
    .dropColumn("upstream_commit")
    .dropColumn("catalogue_manifest")
    .dropColumn("catalogue_schema_version")
    .dropColumn("catalogue_import_id")
    .dropColumn("catalogue_entry_id")
    .execute()
  await db.schema.dropTable("deployment_catalogue_import").execute()
  await sql`alter table store_listing drop constraint store_listing_tagline_check`.execute(db)
  await sql`
    alter table store_listing add constraint store_listing_tagline_check check (length(tagline) <= 140)
  `.execute(db)
}
