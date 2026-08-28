import { sql, type Kysely } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table api_key add column oauth_grant_id uuid
      references oauth_grant(id) on delete restrict
  `.execute(db)
  await sql`
    create index api_key_oauth_grant_id_idx on api_key (oauth_grant_id)
      where oauth_grant_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update api_key set revoked_at = now()
    where oauth_grant_id is not null and revoked_at is null
  `.execute(db)
  await sql`drop index api_key_oauth_grant_id_idx`.execute(db)
  await sql`alter table api_key drop column oauth_grant_id`.execute(db)
}
