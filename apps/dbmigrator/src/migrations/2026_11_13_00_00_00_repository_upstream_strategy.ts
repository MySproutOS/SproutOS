import type { Kysely } from "kysely"
import { sql } from "kysely"

const PUBLIC_CADENCES = [
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "nine_months",
  "one_year",
  "two_years",
] as const

/** Separate how a repository was acquired from how its recorded upstream is reconciled. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("repository").addColumn("upstream_strategy", "text").execute()
  await sql`
    update repository
       set upstream_strategy = case
         when upstream_full_name is null then null
         when is_fork then 'github_fork'
         when provenance = 'template' then 'snapshot_copy'
         else 'manual'
       end
  `.execute(db)
  await db.schema
    .alterTable("repository")
    .addCheckConstraint(
      "repository_upstream_strategy_check",
      sql`upstream_strategy in ('github_fork', 'snapshot_copy', 'manual')`,
    )
    .execute()
  await db.schema
    .alterTable("repository")
    .addCheckConstraint(
      "repository_upstream_strategy_pair_check",
      sql`(upstream_full_name is null) = (upstream_strategy is null)`,
    )
    .execute()

  await db.schema
    .alterTable("project")
    .dropConstraint("project_auto_update_cadence_check")
    .execute()
  await sql`
    update project
       set auto_update_cadence = 'one_week'
     where auto_update_cadence in ('one_day', 'two_days')
  `.execute(db)
  await sql`alter table project alter column auto_update_cadence set default 'one_week'`.execute(db)
  await db.schema
    .alterTable("project")
    .addCheckConstraint(
      "project_auto_update_cadence_check",
      sql`auto_update_cadence in (${sql.join(PUBLIC_CADENCES.map((cadence) => sql.lit(cadence)))})`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .dropConstraint("project_auto_update_cadence_check")
    .execute()
  await sql`alter table project alter column auto_update_cadence set default 'one_day'`.execute(db)
  await db.schema
    .alterTable("project")
    .addCheckConstraint(
      "project_auto_update_cadence_check",
      sql`auto_update_cadence in ('one_day', 'two_days', 'one_week', 'one_month', 'three_months', 'six_months', 'nine_months', 'one_year', 'two_years')`,
    )
    .execute()
  await db.schema
    .alterTable("repository")
    .dropConstraint("repository_upstream_strategy_pair_check")
    .execute()
  await db.schema
    .alterTable("repository")
    .dropConstraint("repository_upstream_strategy_check")
    .execute()
  await db.schema.alterTable("repository").dropColumn("upstream_strategy").execute()
}
