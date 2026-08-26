import { type Kysely, sql } from "kysely"

/**
 * A customer's own hostname, pointed at their project.
 *
 * ADR 0022 calls the generated hostname "a string most customers will replace with a custom
 * domain", and ADR 0018 says custom domains are CNAMEs onto the tenant ingress. Neither had any
 * implementation: no table, no route, no certificate, no verification. This is that table.
 *
 * **Verification exists because DNS is a claim, not a proof.** Anyone can point `example.com` at
 * our load balancer; that must not be enough to make us serve their traffic under someone else's
 * certificate, or to let one tenant park a hostname another tenant owns. The token is published as
 * a TXT record by whoever actually controls the zone, which is the only party who can.
 *
 * Certificates are per domain and DNS-validated, so ACM's own validation record is a second thing
 * the customer must publish. Both are recorded here rather than derived, because a validation
 * record ACM has rotated is a certificate that will never issue and the reason has to be visible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("custom_domain")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull(),
    )
    /** The hostname itself, lowercased. `example.com` or `www.example.com`. */
    .addColumn("hostname", "text", (col) => col.notNull())
    /**
     * Whether this is a zone apex.
     *
     * Recorded rather than re-derived by counting dots, which is wrong for every multi-label public
     * suffix (`example.co.uk` is an apex; `www.example.co.uk` is not, and both have two dots before
     * the last label). It changes the instructions we give: an apex cannot hold a CNAME — that is
     * DNS, not AWS — so it needs ALIAS support at the customer's provider or A records that we
     * cannot promise are stable.
     */
    .addColumn("is_apex", "boolean", (col) => col.notNull().defaultTo(sql`false`))
    /** What the customer publishes as TXT to prove they control the zone. */
    .addColumn("verification_token", "text", (col) => col.notNull())
    .addColumn("verified_at", "timestamptz")
    .addColumn("acm_certificate_arn", "text")
    /** ACM's DNS validation record, so the customer can be told exactly what to publish. */
    .addColumn("acm_validation_name", "text")
    .addColumn("acm_validation_value", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    /** Why it is stuck, in the words of whatever refused it. */
    .addColumn("status_reason", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "custom_domain_status_check",
      sql`status in ('pending', 'verifying', 'issuing', 'active', 'failed')`,
    )
    .execute()

  await sql`create index custom_domain_project_id_idx on custom_domain (project_id)`.execute(db)
  await sql`create index custom_domain_organization_id_idx on custom_domain (organization_id)`.execute(
    db,
  )

  /*
    One live claim per hostname, across the whole platform.

    Not per organization: a hostname resolves to exactly one place in DNS, so two tenants each
    holding `example.com` is not a conflict to resolve later, it is two projects fighting over one
    `route:` key — and whichever deployed last would silently take the other's traffic.
  */
  await sql`
    create unique index custom_domain_hostname_live_key on custom_domain (hostname)
      where deleted_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("custom_domain").execute()
}
