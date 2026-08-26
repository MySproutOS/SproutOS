import { type Kysely, sql } from "kysely"

/**
 * Running a project's database migrations as part of its deploy.
 *
 * `DEPLOYMENT_DOCTRINE` has told the agent since it was written that a deployment covers "automated
 * database migrations on push — migrations run as part of the deploy, before the new version takes
 * traffic". Nothing implemented it. That is the most expensive kind of gap in this repository:
 * documentation that reads as a feature.
 *
 * The artifact is separate from the application's. A migrator is usually a different entry point
 * and frequently a different dependency set, and bundling it into the function that serves traffic
 * would ship migration tooling into every request's cold start.
 *
 * The outcome is recorded on the deployment rather than only in a job's `last_error`, because "why
 * did my deploy fail" is a customer-facing question and a migration's own output is the answer. A
 * job error would say `Job deploy.release failed`, which tells the person nothing they can act on.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("deployment")
    /** The migrator's build, in the same bucket as the application's. Null means no migration step. */
    .addColumn("migration_artifact_key", "text")
    /** Defaults to the application's handler when absent; a migrator often has its own. */
    .addColumn("migration_handler", "text")
    .addColumn("migration_status", "text")
    /*
      What the migrator actually printed, truncated.

      Stored because it is the only useful thing to show a customer whose deploy stopped here, and
      truncated because a migrator that logs every statement can produce megabytes and this column
      is read on a page that renders a list.
    */
    .addColumn("migration_output", "text")
    .addColumn("migration_finished_at", "timestamptz")
    .execute()

  // `alterTable(...).addCheckConstraint` is not chainable after `addColumn` in this Kysely version,
  // so the constraint is added on its own statement rather than silently omitted.
  await sql`
    alter table deployment add constraint deployment_migration_status_check
      check (migration_status is null
             or migration_status in ('pending', 'running', 'succeeded', 'failed', 'skipped'))
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table deployment drop constraint if exists deployment_migration_status_check`.execute(
    db,
  )
  await db.schema
    .alterTable("deployment")
    .dropColumn("migration_artifact_key")
    .dropColumn("migration_handler")
    .dropColumn("migration_status")
    .dropColumn("migration_output")
    .dropColumn("migration_finished_at")
    .execute()
}
