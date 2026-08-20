import { type Kysely, sql } from "kysely"

/**
 * TASKS 38 and 39: an AI reading a repository and saying what it needs to run here.
 *
 * One table, two entry points. Importing a repository that is not in the store analyses it before
 * provisioning, because the manifest's `services` *is* the provisioning input. Proposing one for
 * the store analyses it so that forking it later is cheap for everyone — which is most of what
 * curation means.
 *
 * `organization_id` is who pays. TASK 39 is explicit that the AI billing comes out of the
 * requester's account, and that is true of both entry points: the work is the same work.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("repo_analysis")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("requested_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    // Nullable: an analysis can precede the project it will configure, and a store proposal has no
    // project at all.
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("set null"))
    .addColumn("store_listing_id", "uuid", (col) =>
      col.references("store_listing.id").onDelete("set null"),
    )
    .addColumn("upstream_host", "text", (col) => col.notNull().defaultTo("github.com"))
    .addColumn("upstream_owner", "text", (col) => col.notNull())
    .addColumn("upstream_repo", "text", (col) => col.notNull())
    .addColumn("ref", "text", (col) => col.notNull())
    /** The commit actually analysed. A manifest without one describes a repository that moved. */
    .addColumn("commit_sha", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("error", "text")
    /** The manifest: runtime, commands, services, env vars, modifications, unknowns. */
    .addColumn("manifest", "jsonb")
    /**
     * How much of this the model was willing to stand behind, 0-100.
     *
     * An analyser that cannot say "I don't know" produces a manifest someone trusts and shouldn't,
     * so confidence and `manifest.unknowns` are first-class rather than prose buried in a summary.
     */
    .addColumn("confidence", "int2")
    .addColumn("cost_micro_usd", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "repo_analysis_status_check",
      sql`status in ('queued', 'running', 'succeeded', 'failed')`,
    )
    .addCheckConstraint(
      "repo_analysis_confidence_check",
      sql`confidence is null or confidence between 0 and 100`,
    )
    .execute()

  await sql`create index repo_analysis_organization_id_idx on repo_analysis (organization_id)`.execute(
    db,
  )
  await sql`create index repo_analysis_project_id_idx on repo_analysis (project_id)`.execute(db)
  await sql`create index repo_analysis_store_listing_id_idx on repo_analysis (store_listing_id)`.execute(
    db,
  )
  /**
   * One live analysis per repository and ref.
   *
   * Analysis costs the requester money and two people proposing the same popular project on the
   * same day is the expected case, not an edge one. A finished analysis is reused; only a failed
   * one leaves room to try again.
   */
  await sql`
    create unique index repo_analysis_pending_key on repo_analysis
      (upstream_host, upstream_owner, upstream_repo, ref)
      where status in ('queued', 'running', 'succeeded')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("repo_analysis").execute()
}
