import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("account").addColumn("display_identity", "text").execute()
  await sql`
    update account
       set display_identity = case
         when account.provider = 'github' then "user".github_login
         when account.provider = 'google' then "user".email
         else null
       end
      from "user"
     where "user".id = account.user_id
  `.execute(db)

  await db.schema
    .createTable("oauth_identity_flow")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("state_hash", "text", (col) => col.notNull().unique())
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("cascade").notNull())
    .addColumn("session_key", "text", (col) =>
      col.references("session.session_key").onDelete("cascade").notNull(),
    )
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("intent", "text", (col) => col.notNull())
    .addColumn("target_account_id", "uuid", (col) =>
      col.references("account.id").onDelete("cascade"),
    )
    .addColumn("pkce_ciphertext", "text", (col) => col.notNull())
    .addColumn("pkce_wrapped_dek", "text", (col) => col.notNull())
    .addColumn("pkce_kms_key_id", "text", (col) => col.notNull())
    .addColumn("return_to", "text", (col) => col.notNull())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("consumed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("oauth_identity_flow_provider_check", sql`provider in ('google', 'github')`)
    .addCheckConstraint("oauth_identity_flow_intent_check", sql`intent in ('link', 'reauthorize')`)
    .execute()

  await sql`
    create index oauth_identity_flow_user_created_idx
      on oauth_identity_flow (user_id, created_at desc)
  `.execute(db)
  await sql`create index oauth_identity_flow_expires_idx on oauth_identity_flow (expires_at)`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("oauth_identity_flow").execute()
  await db.schema.alterTable("account").dropColumn("display_identity").execute()
}
