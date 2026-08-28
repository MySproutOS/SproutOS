import { sql, type Kysely } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table project add column created_by_oauth_grant_id uuid
      references oauth_grant(id) on delete set null
  `.execute(db)
  await sql`
    create index project_created_by_oauth_grant_id_idx on project (created_by_oauth_grant_id)
      where created_by_oauth_grant_id is not null
  `.execute(db)
  await sql`drop index service_credential_live_username_purpose_branch_key`.execute(db)
  await sql`
    create unique index service_credential_live_principal_key
      on service_credential (
        username,
        purpose,
        coalesce(database_branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
        coalesce(oauth_grant_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      where revoked_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update service_credential set revoked_at = now()
    where oauth_grant_id is not null and revoked_at is null
  `.execute(db)
  await sql`drop index service_credential_live_principal_key`.execute(db)
  await sql`
    create unique index service_credential_live_username_purpose_branch_key
      on service_credential (
        username,
        purpose,
        coalesce(database_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      where revoked_at is null
  `.execute(db)
  await sql`drop index project_created_by_oauth_grant_id_idx`.execute(db)
  await sql`alter table project drop column created_by_oauth_grant_id`.execute(db)
}
