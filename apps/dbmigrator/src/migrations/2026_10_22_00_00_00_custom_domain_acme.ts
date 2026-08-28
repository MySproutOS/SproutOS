import { type Kysely, sql } from "kysely"

/**
 * Move custom domains from synchronous ACM/ALB attachment to the asynchronous certificate
 * lifecycle owned by the Rust tenant edge.
 *
 * There are no launched customer domains to preserve. Refusing to migrate a live row is deliberate:
 * silently dropping an attached ACM certificate would turn a schema deployment into an outage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ count: string }>`
    select count(*)::text as count from custom_domain
  `.execute(db)
  if (existing.rows[0]?.count !== "0") {
    throw new Error(
      "custom_domain ACME cutover requires an empty table; migrate the existing certificates explicitly",
    )
  }

  await db.schema.alterTable("custom_domain").dropConstraint("custom_domain_status_check").execute()
  await db.schema
    .alterTable("custom_domain")
    .dropColumn("acm_certificate_arn")
    .dropColumn("acm_validation_name")
    .dropColumn("acm_validation_value")
    .addColumn("certificate_object_key", "text")
    .addColumn("certificate_object_version", "text")
    .addColumn("certificate_issued_at", "timestamptz")
    .addColumn("certificate_expires_at", "timestamptz")
    .addColumn("next_renewal_at", "timestamptz")
    .addColumn("next_retry_at", "timestamptz")
    .addColumn("last_checked_at", "timestamptz")
    .addColumn("claim_expires_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now() + interval '30 days'`),
    )
    .addColumn("reconcile_lease_token", "uuid")
    .addColumn("reconcile_lease_expires_at", "timestamptz")
    .execute()

  await db.schema
    .alterTable("custom_domain")
    .addCheckConstraint(
      "custom_domain_status_check",
      sql`status in (
        'pending_dns',
        'issuing',
        'propagating',
        'active',
        'renewal_warning',
        'failed',
        'deleting'
      )`,
    )
    .execute()

  await sql`alter table custom_domain alter column status set default 'pending_dns'`.execute(db)
  await sql`create index custom_domain_reconcile_due_idx on custom_domain (next_retry_at)
    where deleted_at is null and status <> 'active'`.execute(db)
  await sql`create index custom_domain_renewal_due_idx on custom_domain (next_renewal_at)
    where deleted_at is null and certificate_object_key is not null`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ count: string }>`
    select count(*)::text as count from custom_domain
  `.execute(db)
  if (existing.rows[0]?.count !== "0") {
    throw new Error(
      "custom_domain ACM rollback requires an empty table; certificates cannot be reconstructed from ACME state",
    )
  }

  await db.schema.alterTable("custom_domain").dropConstraint("custom_domain_status_check").execute()
  await sql`drop index custom_domain_reconcile_due_idx`.execute(db)
  await sql`drop index custom_domain_renewal_due_idx`.execute(db)
  await db.schema
    .alterTable("custom_domain")
    .dropColumn("certificate_object_key")
    .dropColumn("certificate_object_version")
    .dropColumn("certificate_issued_at")
    .dropColumn("certificate_expires_at")
    .dropColumn("next_renewal_at")
    .dropColumn("next_retry_at")
    .dropColumn("last_checked_at")
    .dropColumn("claim_expires_at")
    .dropColumn("reconcile_lease_token")
    .dropColumn("reconcile_lease_expires_at")
    .addColumn("acm_certificate_arn", "text")
    .addColumn("acm_validation_name", "text")
    .addColumn("acm_validation_value", "text")
    .execute()
  await db.schema
    .alterTable("custom_domain")
    .addCheckConstraint(
      "custom_domain_status_check",
      sql`status in ('pending', 'verifying', 'issuing', 'active', 'failed')`,
    )
    .execute()
  await sql`alter table custom_domain alter column status set default 'pending'`.execute(db)
}
