import type { Kysely } from "kysely"
import { sql } from "kysely"

const CADENCES = [
  "one_day",
  "two_days",
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "nine_months",
  "one_year",
  "two_years",
] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("upstreamSyncRun")
    .dropConstraint("upstream_sync_run_outcome_check")
    .execute()
  await db.schema
    .alterTable("upstreamSyncRun")
    .addCheckConstraint(
      "upstream_sync_run_outcome_check",
      sql`outcome in ('up_to_date', 'pr_opened', 'merged', 'conflict', 'failed')`,
    )
    .execute()
  await db.schema
    .alterTable("project")
    .dropConstraint("project_auto_update_cadence_check")
    .execute()

  await sql`
    update project
       set auto_update_cadence = case auto_update_cadence
         when 'weekly' then 'one_week'
         when 'monthly' then 'one_month'
         else 'one_day'
       end
  `.execute(db)

  await sql`alter table project alter column auto_update_cadence set default 'one_day'`.execute(db)
  await db.schema
    .alterTable("project")
    .addCheckConstraint(
      "project_auto_update_cadence_check",
      sql`auto_update_cadence in (${sql.join(CADENCES.map((cadence) => sql.lit(cadence)))})`,
    )
    .execute()

  await db.schema.alterTable("repository").dropColumn("upstream_tag_checked_at").execute()
  await db.schema.alterTable("repository").dropColumn("upstream_tag_fingerprint").execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`update upstream_sync_run set outcome = 'pr_opened' where outcome = 'merged'`.execute(db)
  await db.schema
    .alterTable("upstreamSyncRun")
    .dropConstraint("upstream_sync_run_outcome_check")
    .execute()
  await db.schema
    .alterTable("upstreamSyncRun")
    .addCheckConstraint(
      "upstream_sync_run_outcome_check",
      sql`outcome in ('up_to_date', 'pr_opened', 'conflict', 'failed')`,
    )
    .execute()
  await db.schema
    .alterTable("repository")
    .addColumn("upstream_tag_fingerprint", "text")
    .addColumn("upstream_tag_checked_at", "timestamptz")
    .execute()

  await db.schema
    .alterTable("project")
    .dropConstraint("project_auto_update_cadence_check")
    .execute()
  await sql`
    update project
       set auto_update_cadence = case auto_update_cadence
         when 'one_week' then 'weekly'
         when 'one_month' then 'monthly'
         else 'daily'
       end
  `.execute(db)
  await sql`alter table project alter column auto_update_cadence set default 'daily'`.execute(db)
  await db.schema
    .alterTable("project")
    .addCheckConstraint(
      "project_auto_update_cadence_check",
      sql`auto_update_cadence in ('tag', 'daily', 'weekly', 'monthly')`,
    )
    .execute()
}
