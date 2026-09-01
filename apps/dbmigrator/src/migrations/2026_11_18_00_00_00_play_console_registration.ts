import { type Kysely, sql } from "kysely"

/**
 * Expand phase for the Play Console cutover. Registration belongs to the Play Console organization
 * and is independently observed through the Android Developer ID Status API. New binaries never
 * select or write a Developer Console account, but the deprecated nullable columns remain until a
 * later contract migration proves every old API, worker, and signer task is gone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists client_signing_identity_developer_console_account_write_once on client_signing_identity`.execute(
    db,
  )
  await sql`drop trigger if exists android_app_developer_console_account_write_once on android_app`.execute(
    db,
  )
  await sql`drop function if exists enforce_developer_console_account_write_once()`.execute(db)

  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_registered_identity_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_registered_identity_check",
      sql`developer_console_state <> 'registered'
        or developer_console_provider_state is not distinct from 'REGISTERED'`,
    )
    .execute()

  await db.schema
    .alterTable("android_app")
    .dropConstraint("android_app_registered_developer_account_check")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rows registered by the new control plane may have no deprecated account value. Return only
  // those rows to the fail-closed pending state before restoring the old account-required checks.
  await sql`
    update android_app
    set developer_console_state = 'pending_registration', updated_at = now()
    where developer_console_state = 'registered'
      and developer_console_account is null;
    update client_signing_identity
    set developer_console_state = 'pending_registration', updated_at = now()
    where developer_console_state = 'registered'
      and developer_console_account is null
  `.execute(db)

  await db.schema
    .alterTable("android_app")
    .addCheckConstraint(
      "android_app_registered_developer_account_check",
      sql`developer_console_state <> 'registered' or developer_console_account is not null`,
    )
    .execute()

  await db.schema
    .alterTable("client_signing_identity")
    .dropConstraint("client_signing_identity_registered_identity_check")
    .execute()
  await db.schema
    .alterTable("client_signing_identity")
    .addCheckConstraint(
      "client_signing_identity_registered_identity_check",
      sql`developer_console_state <> 'registered' or (
        developer_console_account is not null and
        developer_console_provider_state is not distinct from 'REGISTERED'
      )`,
    )
    .execute()

  await sql`
    create function enforce_developer_console_account_write_once()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.developer_console_account is not null and
         new.developer_console_account is distinct from old.developer_console_account then
        raise exception 'developer_console_account is immutable once set'
          using errcode = '23514', constraint = 'developer_console_account_write_once';
      end if;
      return new;
    end
    $$
  `.execute(db)
  await sql`
    create trigger android_app_developer_console_account_write_once
    before update of developer_console_account on android_app
    for each row execute function enforce_developer_console_account_write_once()
  `.execute(db)
  await sql`
    create trigger client_signing_identity_developer_console_account_write_once
    before update of developer_console_account on client_signing_identity
    for each row execute function enforce_developer_console_account_write_once()
  `.execute(db)
}
