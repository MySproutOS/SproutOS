import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Make the upstream-update schedule a customer choice rather than an implicit nightly timer.
 *
 * `auto_update_enabled = false` remains the one representation of Off.  Cadence is deliberately
 * orthogonal: turning updates off and back on preserves the interval the customer chose instead of
 * replacing it with a magic `off` enum value.
 *
 * Tag cadence is a trigger, not a version selector. The worker remembers a fingerprint of every
 * upstream tag name and target, then runs the ordinary safe upstream sync when the set changes.
 * A fingerprint catches additions, deletions, and moved tags without assuming SemVer or relying on
 * an undocumented ordering from GitHub's tags endpoint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .addColumn("auto_update_cadence", "text", (col) => col.notNull().defaultTo("daily"))
    .execute()

  await db.schema
    .alterTable("project")
    .addCheckConstraint(
      "project_auto_update_cadence_check",
      sql`auto_update_cadence in ('tag', 'daily', 'weekly', 'monthly')`,
    )
    .execute()

  await db.schema
    .alterTable("repository")
    .addColumn("upstream_tag_fingerprint", "text")
    .addColumn("upstream_tag_checked_at", "timestamptz")
    .execute()

  // Accepted conflict resolution is a durable project job. The immutable expected heads and the
  // audited patch digest must survive a worker crash independently of the retry queue's payload.
  await db.schema
    .alterTable("project_job")
    .addColumn("details", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute()

  // An accepted update uses a one-shot Daytona machine, never the user's persistent dev sandbox.
  // Purpose makes both rows attributable and metered without weakening the dev-sandbox invariant.
  await sql`drop index sandbox_project_user_key`.execute(db)
  await db.schema
    .alterTable("sandbox")
    .addColumn("purpose", "text", (col) => col.notNull().defaultTo("development"))
    .execute()
  await db.schema
    .alterTable("sandbox")
    .addCheckConstraint(
      "sandbox_purpose_check",
      sql`purpose in ('development', 'upstream_resolution')`,
    )
    .execute()
  await sql`
    create unique index sandbox_project_user_purpose_key
      on sandbox (project_id, user_id, purpose)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index sandbox_project_user_purpose_key`.execute(db)
  await db.schema.alterTable("sandbox").dropConstraint("sandbox_purpose_check").execute()
  await db.schema.alterTable("sandbox").dropColumn("purpose").execute()
  await sql`
    create unique index sandbox_project_user_key on sandbox (project_id, user_id)
  `.execute(db)
  await db.schema.alterTable("project_job").dropColumn("details").execute()
  await db.schema.alterTable("repository").dropColumn("upstream_tag_checked_at").execute()
  await db.schema.alterTable("repository").dropColumn("upstream_tag_fingerprint").execute()
  await db.schema
    .alterTable("project")
    .dropConstraint("project_auto_update_cadence_check")
    .execute()
  await db.schema.alterTable("project").dropColumn("auto_update_cadence").execute()
}
