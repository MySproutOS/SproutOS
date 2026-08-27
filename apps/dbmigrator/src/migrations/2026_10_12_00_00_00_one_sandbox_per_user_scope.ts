import { sql, type Kysely } from "kysely"

/** One rented workspace per user and repository-group scope. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sandbox drop constraint sandbox_state_check,
      add constraint sandbox_state_check
      check (state in ('starting', 'running', 'idle', 'stopped', 'failed', 'deleting'))
  `.execute(db)

  await sql`
    create unique index sandbox_project_user_key on sandbox (project_id, user_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists sandbox_project_user_key`.execute(db)
  await sql`update sandbox set state = 'failed' where state = 'deleting'`.execute(db)
  await sql`
    alter table sandbox drop constraint sandbox_state_check,
      add constraint sandbox_state_check
      check (state in ('starting', 'running', 'idle', 'stopped', 'failed'))
  `.execute(db)
}
