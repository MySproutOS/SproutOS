import { type Kysely, sql } from "kysely"

/**
 * Make certificate provenance and renewal scheduling durable.
 *
 * A certificate issued by Let's Encrypt staging is cryptographically valid but is not publicly
 * trusted. Persisting the configured ACME directory beside every object makes a staging to
 * production change observable and forces reissuance instead of accidentally activating the old
 * material. The RFC 9773 identifier/check time are also durable so every worker restart continues
 * the CA-directed renewal schedule.
 *
 * Exact customer certificates now use the same stable-key/exact-VersionId handoff as the platform
 * certificate. The deployed object key/version retains the prior serving material until all router
 * replicas acknowledge its replacement, after which the worker can delete that obsolete private-key
 * version explicitly (including a legacy expiry-derived key).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("custom_domain")
    .addColumn("certificate_issuer", "text")
    .addColumn("certificate_directory_url", "text")
    .addColumn("deployed_certificate_object_key", "text")
    .addColumn("deployed_certificate_object_version", "text")
    .addColumn("renewal_info_certificate_id", "text")
    .addColumn("renewal_info_retry_at", "timestamptz")
    .addColumn("renewal_info_explanation_url", "text")
    .execute()
  await db.schema
    .alterTable("custom_domain")
    .addCheckConstraint(
      "custom_domain_certificate_provenance_pair_check",
      sql`(certificate_issuer is null) = (certificate_directory_url is null)`,
    )
    .execute()
  await db.schema
    .alterTable("custom_domain")
    .addCheckConstraint(
      "custom_domain_deployed_object_pair_check",
      sql`(deployed_certificate_object_key is null) = (deployed_certificate_object_version is null)`,
    )
    .execute()

  await db.schema
    .alterTable("platform_edge_certificate")
    .addColumn("certificate_issuer", "text")
    .addColumn("certificate_directory_url", "text")
    .addColumn("renewal_info_certificate_id", "text")
    .addColumn("renewal_info_retry_at", "timestamptz")
    .addColumn("renewal_info_explanation_url", "text")
    .execute()
  await db.schema
    .alterTable("platform_edge_certificate")
    .addCheckConstraint(
      "platform_edge_certificate_provenance_pair_check",
      sql`(certificate_issuer is null) = (certificate_directory_url is null)`,
    )
    .execute()

  await sql`
    update custom_domain
       set deployed_certificate_object_key = certificate_object_key,
           deployed_certificate_object_version = certificate_object_version,
           next_retry_at = now(),
           updated_at = now()
     where certificate_object_version is not null
       and status in ('active', 'renewal_warning')
  `.execute(db)
  await sql`
    update platform_edge_certificate
       set next_retry_at = now(),
           updated_at = now()
     where certificate_object_version is not null
  `.execute(db)

  await sql`
    create index custom_domain_renewal_info_due_idx on custom_domain (renewal_info_retry_at)
      where deleted_at is null and renewal_info_retry_at is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index custom_domain_renewal_info_due_idx`.execute(db)
  await db.schema
    .alterTable("custom_domain")
    .dropConstraint("custom_domain_certificate_provenance_pair_check")
    .execute()
  await db.schema
    .alterTable("custom_domain")
    .dropConstraint("custom_domain_deployed_object_pair_check")
    .execute()
  await db.schema
    .alterTable("custom_domain")
    .dropColumn("certificate_issuer")
    .dropColumn("certificate_directory_url")
    .dropColumn("deployed_certificate_object_key")
    .dropColumn("deployed_certificate_object_version")
    .dropColumn("renewal_info_certificate_id")
    .dropColumn("renewal_info_retry_at")
    .dropColumn("renewal_info_explanation_url")
    .execute()
  await db.schema
    .alterTable("platform_edge_certificate")
    .dropConstraint("platform_edge_certificate_provenance_pair_check")
    .execute()
  await db.schema
    .alterTable("platform_edge_certificate")
    .dropColumn("certificate_issuer")
    .dropColumn("certificate_directory_url")
    .dropColumn("renewal_info_certificate_id")
    .dropColumn("renewal_info_retry_at")
    .dropColumn("renewal_info_explanation_url")
    .execute()
}
