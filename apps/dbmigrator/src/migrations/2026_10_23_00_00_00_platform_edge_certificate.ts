import { sql, type Kysely } from "kysely"

/**
 * Durable desired/served state for the one certificate presented by the Rust edge for platform
 * hostnames. The certificate is immutable startup input, unlike exact customer certificates, so
 * `certificate_object_version` is desired state and `deployed_object_version` advances only after
 * restarted router replicas acknowledge that exact S3 version.
 *
 * The singleton row also carries a renewable lease. ACME orders perform several network calls and
 * must not hold a database transaction or advisory lock for their duration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("platform_edge_certificate")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("due"))
    .addColumn("status_reason", "text")
    .addColumn("certificate_object_key", "text")
    .addColumn("certificate_object_version", "text")
    .addColumn("restart_requested_object_version", "text")
    .addColumn("deployed_object_version", "text")
    .addColumn("certificate_issued_at", "timestamptz")
    .addColumn("certificate_expires_at", "timestamptz")
    .addColumn("next_renewal_at", "timestamptz")
    .addColumn("next_retry_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("consecutive_failures", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("reconcile_lease_token", "uuid")
    .addColumn("reconcile_lease_expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("platform_edge_certificate_singleton_check", sql`id = 'platform'`)
    .addCheckConstraint(
      "platform_edge_certificate_status_check",
      sql`status in ('due', 'issuing', 'awaiting_deployment', 'active', 'renewal_warning', 'failed')`,
    )
    .addCheckConstraint(
      "platform_edge_certificate_object_pair_check",
      sql`(certificate_object_key is null) = (certificate_object_version is null)`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("platform_edge_certificate").execute()
}
