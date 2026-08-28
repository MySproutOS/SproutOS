import { type Kysely, sql } from "kysely"

/** Non-secret Android Developer Console status for the canonical catalogue client. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("android_app").addColumn("developer_console_account", "text").execute()
  // Older status-only reconciliation could mark an app registered without knowing which verified
  // developer account owned it. That is insufficient after the signer-side custody boundary is
  // enforced, so upgrades deliberately return those rows to fail-closed pending state.
  await sql`
    update deployment
    set status = 'queued', updated_at = now()
    from android_app
    where android_app.developer_console_state = 'registered'
      and android_app.latest_good_deployment_id = deployment.id
      and deployment.status = 'ready'
  `.execute(db)
  await sql`
    update android_app
    set developer_console_state = 'pending_registration',
        developer_console_next_check_at = now(),
        developer_console_claim_token = null,
        developer_console_claim_expires_at = null,
        updated_at = now()
    where developer_console_state = 'registered'
  `.execute(db)
  await db.schema
    .alterTable("android_app")
    .addCheckConstraint(
      "android_app_developer_console_account_check",
      sql`developer_console_account is null or developer_console_account ~ '^developerAccounts/[0-9]+$'`,
    )
    .execute()
  await db.schema
    .alterTable("android_app")
    .addCheckConstraint(
      "android_app_registered_developer_account_check",
      sql`developer_console_state <> 'registered' or developer_console_account is not null`,
    )
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addColumn("developer_console_account", "text")
    .addColumn("developer_console_state", "text", (col) =>
      col.notNull().defaultTo("pending_registration"),
    )
    .addColumn("developer_console_provider_state", "text")
    .addColumn("developer_console_last_checked_at", "timestamptz")
    .addColumn("developer_console_error", "text")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_developer_console_state_check",
      sql`developer_console_state in ('pending_registration', 'registered', 'failed')`,
    )
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_registered_developer_account_check",
      sql`developer_console_state <> 'registered' or developer_console_account is not null`,
    )
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_developer_console_account_check",
      sql`developer_console_account is null or developer_console_account ~ '^developerAccounts/[0-9]+$'`,
    )
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_developer_console_provider_state_check",
      sql`developer_console_provider_state is null or developer_console_provider_state in
        ('NOT_REGISTERED', 'REGISTERED', 'REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT')`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_developer_console_provider_state_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_developer_console_state_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_developer_console_account_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_registered_developer_account_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .dropColumn("developer_console_error")
    .dropColumn("developer_console_last_checked_at")
    .dropColumn("developer_console_provider_state")
    .dropColumn("developer_console_state")
    .dropColumn("developer_console_account")
    .execute()
  await db.schema
    .alterTable("android_app")
    .dropConstraint("android_app_developer_console_account_check")
    .execute()
  await db.schema
    .alterTable("android_app")
    .dropConstraint("android_app_registered_developer_account_check")
    .execute()
  await db.schema.alterTable("android_app").dropColumn("developer_console_account").execute()
}
