import { sql, type Kysely } from "kysely"
import type { DB } from "@sproutos/db"

/**
 * Carry the static archive all the way from the deploy action to the publisher and edge.
 *
 * `POST /deploy/release` has accepted these values since the static preset was introduced, but
 * discarded them before the row was written. Keeping the preset is equally important: Next and
 * Hono releases may carry auxiliary assets, while `static` has no Lambda to publish at all.
 */
export async function up(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("project").addColumn("serving_mode", "text").execute()
  await sql`
    alter table project
      add constraint project_serving_mode_ck check (serving_mode in ('static', 'serverless'))
  `.execute(db)
  await sql`drop index if exists deployment_preview_pr_key`.execute(db)
  await sql`
    create index deployment_preview_pr_idx on deployment (project_id, pr_number, created_at desc)
      where kind = 'preview' and deleted_at is null
  `.execute(db)

  await db.schema
    .alterTable("deployment")
    .addColumn("preset", "text", (column) => column.notNull().defaultTo("unknown"))
    .addColumn("static_artifact_key", "text")
    .addColumn("static_digest", "text")
    .execute()

  await sql`
    alter table deployment
      add constraint deployment_static_archive_pair_ck check (
        (static_artifact_key is null and static_digest is null)
        or
        (static_artifact_key is not null and static_digest ~ '^[0-9a-f]{64}$')
      )
  `.execute(db)
}

export async function down(db: Kysely<DB>): Promise<void> {
  await sql`drop index if exists deployment_preview_pr_idx`.execute(db)
  await sql`
    create unique index deployment_preview_pr_key on deployment (project_id, pr_number)
      where kind = 'preview' and status <> 'torn_down' and deleted_at is null
  `.execute(db)
  await sql`alter table project drop constraint if exists project_serving_mode_ck`.execute(db)
  await sql`
    alter table deployment drop constraint if exists deployment_static_archive_pair_ck
  `.execute(db)
  await db.schema
    .alterTable("deployment")
    .dropColumn("static_digest")
    .dropColumn("static_artifact_key")
    .dropColumn("preset")
    .execute()
  await db.schema.alterTable("project").dropColumn("serving_mode").execute()
}
