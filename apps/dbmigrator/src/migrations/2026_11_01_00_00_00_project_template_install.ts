import type { Kysely } from "kysely"
import { sql } from "kysely"

/** Immutable catalogue provenance and the durable state of one template application. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("project_template_install")
    .addColumn("project_id", "uuid", (col) =>
      col.primaryKey().references("project.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "uuid", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("store_listing_id", "uuid", (col) =>
      col.notNull().references("store_listing.id").onDelete("restrict"),
    )
    .addColumn("catalogue_import_id", "uuid", (col) =>
      col.notNull().references("deployment_catalogue_import.id").onDelete("restrict"),
    )
    .addColumn("catalogue_entry_id", "text", (col) => col.notNull())
    .addColumn("catalogue_digest", "text", (col) => col.notNull())
    .addColumn("manifest_digest", "text", (col) => col.notNull())
    .addColumn("deployment_templates_commit", "text", (col) => col.notNull())
    .addColumn("manifest", "jsonb", (col) => col.notNull())
    .addColumn("plugin_repository", "text", (col) => col.notNull())
    .addColumn("plugin_digest", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("configuring"))
    .addColumn("apply_result", "jsonb")
    .addColumn("prepared_commit_sha", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_message", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "project_template_install_catalogue_digest_check",
      sql`catalogue_digest ~ '^sha256:[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "project_template_install_manifest_digest_check",
      sql`manifest_digest ~ '^sha256:[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "project_template_install_plugin_digest_check",
      sql`plugin_digest ~ '^sha256:[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "project_template_install_source_commit_check",
      sql`deployment_templates_commit ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "project_template_install_prepared_commit_check",
      sql`prepared_commit_sha is null or prepared_commit_sha ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "project_template_install_state_check",
      sql`state in ('configuring', 'provisioning', 'forking', 'preparing', 'deploying', 'ready', 'failed')`,
    )
    .execute()

  await db.schema
    .createTable("project_template_service")
    .addColumn("project_id", "uuid", (col) =>
      col.notNull().references("project.id").onDelete("cascade"),
    )
    .addColumn("service_key", "text", (col) => col.notNull())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.notNull().unique().references("backend_service.id").onDelete("restrict"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("bindings", "jsonb", (col) => col.notNull())
    .addColumn("provisioned_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("project_template_service_pkey", ["project_id", "service_key"])
    .addCheckConstraint(
      "project_template_service_kind_check",
      sql`kind in ('postgres', 'valkey', 'elasticsearch', 'object_storage')`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_template_service").execute()
  await db.schema.dropTable("project_template_install").execute()
}
