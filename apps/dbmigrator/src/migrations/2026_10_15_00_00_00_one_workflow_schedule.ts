import { sql, type Kysely } from "kysely"
import type { DB } from "@sproutos/db"

/** A graph has one trigger, therefore a workflow has at most one live cron schedule. */
export async function up(db: Kysely<DB>): Promise<void> {
  await sql`create unique index workflow_schedule_workflow_key on workflow_schedule (workflow_id)`.execute(
    db,
  )
}

export async function down(db: Kysely<DB>): Promise<void> {
  await sql`drop index if exists workflow_schedule_workflow_key`.execute(db)
}
