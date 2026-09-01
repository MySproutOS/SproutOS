import { type Kysely, sql } from "kysely"

/**
 * The catalogue client has one platform-owned signing identity and an append-only job history.
 * Keeping this separate from customer android_app rows avoids inventing a tenant project for the
 * store itself, while the immutable object versions make every published release reproducible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // A signer identity is stable across retries, so it cannot fence a callback from an expired
  // claim after that same signer has reclaimed the job. Each claim gets an unpredictable token;
  // completion and failure callbacks must present the exact token for the attempt they report.
  await sql`
    alter table android_signer_job
      add column claim_token text,
      add column callback_claim_token text
  `.execute(db)
  // No pre-token lease can be authenticated by the new protocol. Requeue it instead of either
  // fabricating a token or letting an old in-flight callback cross the migration boundary.
  await sql`
    update android_signer_job
      set state = 'queued', claimed_by = null, claimed_at = null, updated_at = now()
      where state = 'running'
  `.execute(db)
  // Legacy callback hashes did not cover a claim token and cannot be represented as fenced
  // history. The corresponding terminal/queued state remains; only obsolete replay metadata goes.
  await sql`
    update android_signer_job set callback_idempotency_key = null
      where callback_idempotency_key is not null
  `.execute(db)
  await sql`
    alter table android_signer_job
      add constraint android_signer_job_claim_token_check check (
        (state = 'running') = coalesce(claim_token ~ '^[0-9a-f]{64}$', false)
      ),
      add constraint android_signer_job_callback_claim_token_check check (
        (callback_idempotency_key is null and callback_claim_token is null)
        or (callback_idempotency_key is not null and callback_claim_token ~ '^[0-9a-f]{64}$')
      )
  `.execute(db)

  // The package is an identity derived from the owning project, not editable metadata. Keep this
  // at the database boundary so a generic DAO update or callback bug cannot move an installed app
  // onto another package name.
  await db.schema
    .alterTable("android_app")
    .addCheckConstraint(
      "android_app_project_package_identity_check",
      sql`package_name = 'me.sproutos.app.p' || replace(project_id::text, '-', '')`,
    )
    .execute()
  await sql`
    create function sproutos_android_app_identity_immutable() returns trigger as $$
    begin
      if new.project_id is distinct from old.project_id
        or new.package_name is distinct from old.package_name then
        raise exception 'android_app project/package identity is immutable'
          using errcode = '23514';
      end if;
      return new;
    end;
    $$ language plpgsql
  `.execute(db)
  await sql`
    create trigger android_app_identity_immutable
      before update of project_id, package_name on android_app
      for each row execute function sproutos_android_app_identity_immutable()
  `.execute(db)

  await db.schema
    .createTable("client_signing_identity")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("package_name", "text", (col) => col.notNull().unique())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("key_object_key", "text")
    .addColumn("key_object_version", "text")
    .addColumn("certificate_sha256", "text")
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "client_signing_identity_package_check",
      sql`package_name = 'com.sproutos.store'`,
    )
    .addCheckConstraint(
      "client_signing_identity_state_check",
      sql`state in ('pending', 'provisioning', 'ready', 'failed')`,
    )
    .addCheckConstraint(
      "client_signing_identity_certificate_check",
      sql`certificate_sha256 is null or certificate_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "client_signing_identity_key_shape_check",
      sql`(
        state = 'ready'
        and key_object_key = 'keys/client/signing.keystore.enc'
        and length(key_object_version) > 0
        and certificate_sha256 is not null
      ) or (
        state <> 'ready'
        and key_object_key is null
        and key_object_version is null
        and certificate_sha256 is null
      )`,
    )
    .execute()

  await db.schema
    .createTable("client_signer_job")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("client_signing_identity_id", "uuid", (col) =>
      col.references("client_signing_identity.id").onDelete("restrict").notNull(),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("operator_signer_id", "text", (col) => col.notNull())
    .addColumn("claimed_by", "text")
    .addColumn("claimed_at", "timestamptz")
    .addColumn("claim_token", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("upload_idempotency_key", "text")
    .addColumn("callback_idempotency_key", "text")
    .addColumn("callback_kind", "text")
    .addColumn("callback_signer_id", "text")
    .addColumn("callback_claim_token", "text")
    .addColumn("unsigned_key", "text")
    .addColumn("unsigned_object_version", "text")
    .addColumn("unsigned_digest", "text")
    .addColumn("unsigned_size_bytes", "bigint")
    .addColumn("input_mime", "text")
    .addColumn("version_code", "integer")
    .addColumn("version_name", "text")
    .addColumn("signed_key", "text")
    .addColumn("signed_object_version", "text")
    .addColumn("signed_digest", "text")
    .addColumn("signed_size_bytes", "bigint")
    .addColumn("signed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "client_signer_job_kind_check",
      sql`kind in ('provision_client_key', 'sign_client_release')`,
    )
    .addCheckConstraint(
      "client_signer_job_state_check",
      sql`state in ('awaiting_upload', 'queued', 'running', 'succeeded', 'failed')`,
    )
    .addCheckConstraint("client_signer_job_attempts_check", sql`attempts >= 0`)
    .addCheckConstraint(
      "client_signer_job_operator_check",
      sql`length(operator_signer_id) between 1 and 200`,
    )
    .addCheckConstraint(
      "client_signer_job_claim_token_check",
      sql`(state = 'running') = coalesce(claim_token ~ '^[0-9a-f]{64}$', false)`,
    )
    .addCheckConstraint(
      "client_signer_job_idempotency_check",
      sql`(upload_idempotency_key is null or upload_idempotency_key ~ '^[0-9a-f]{64}$')
        and (
          (callback_idempotency_key is null and callback_kind is null and callback_signer_id is null
            and callback_claim_token is null)
          or (
            callback_idempotency_key ~ '^[0-9a-f]{64}$'
            and callback_kind in ('complete', 'fail')
            and length(callback_signer_id) between 1 and 200
            and callback_claim_token ~ '^[0-9a-f]{64}$'
          )
        )`,
    )
    .addCheckConstraint(
      "client_signer_job_shape_check",
      sql`(
        kind = 'provision_client_key'
        and state <> 'awaiting_upload'
        and unsigned_key is null
        and unsigned_object_version is null
        and unsigned_digest is null
        and unsigned_size_bytes is null
        and input_mime is null
        and version_code is null
      ) or (
        kind = 'sign_client_release'
        and unsigned_key = 'raw/client/' || id::text || '.apk'
        and unsigned_digest ~ '^[0-9a-f]{64}$'
        and unsigned_size_bytes > 0
        and input_mime = 'application/vnd.android.package-archive'
        and version_code between 1 and 2100000000
        and (
          (state = 'awaiting_upload' and unsigned_object_version is null)
          or (state <> 'awaiting_upload' and length(unsigned_object_version) > 0)
        )
      )`,
    )
    .addCheckConstraint(
      "client_signer_job_signed_shape_check",
      sql`(
        kind = 'sign_client_release'
        and state = 'succeeded'
        and signed_key = 'signed/client/' || id::text || '.apk'
        and length(signed_object_version) > 0
        and signed_digest ~ '^[0-9a-f]{64}$'
        and signed_size_bytes > 0
        and length(version_name) between 1 and 100
        and signed_at is not null
      ) or (
        (kind = 'provision_client_key' or state <> 'succeeded')
        and signed_key is null
        and signed_object_version is null
        and signed_digest is null
        and signed_size_bytes is null
        and version_name is null
        and signed_at is null
      )`,
    )
    .execute()

  await sql`
    create unique index client_signer_job_provision_key
      on client_signer_job (client_signing_identity_id)
      where kind = 'provision_client_key'
  `.execute(db)
  await sql`
    create unique index client_signer_job_version_key
      on client_signer_job (client_signing_identity_id, version_code)
      where kind = 'sign_client_release' and state <> 'failed'
  `.execute(db)
  await sql`
    create index client_signer_job_claim_idx
      on client_signer_job (created_at)
      where state = 'queued'
  `.execute(db)
  await sql`
    create unique index client_signer_job_unsigned_object_version_key
      on client_signer_job (unsigned_key, unsigned_object_version)
      where unsigned_object_version is not null
  `.execute(db)
  await sql`
    create unique index client_signer_job_signed_object_version_key
      on client_signer_job (signed_key, signed_object_version)
      where signed_object_version is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("client_signer_job").execute()
  await db.schema.dropTable("client_signing_identity").execute()
  await sql`
    alter table android_signer_job
      drop constraint android_signer_job_callback_claim_token_check,
      drop constraint android_signer_job_claim_token_check,
      drop column callback_claim_token,
      drop column claim_token
  `.execute(db)
  await sql`drop trigger android_app_identity_immutable on android_app`.execute(db)
  await sql`drop function sproutos_android_app_identity_immutable()`.execute(db)
  await db.schema
    .alterTable("android_app")
    .dropConstraint("android_app_project_package_identity_check")
    .execute()
}
