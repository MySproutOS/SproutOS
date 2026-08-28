import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("store_listing")
    .addColumn("deployment_source_owner", "text")
    .addColumn("deployment_source_repo", "text")
    .addColumn("deployment_instructions_path", "text")
    .execute()

  await sql`
    update store_listing
    set deployment_source_owner = 'SproutOS-Apps',
        deployment_source_repo = upstream_repo,
        deployment_instructions_path = 'SPROUT_OS_DEPLOY.md'
    where deleted_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("store_listing")
    .dropColumn("deployment_instructions_path")
    .dropColumn("deployment_source_repo")
    .dropColumn("deployment_source_owner")
    .execute()
}
