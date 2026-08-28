import { type Kysely, sql } from "kysely"

// Per-project signing identity, registration state, and durable release-job lifecycle.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("android_app")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull().unique(),
    )
    .addColumn("package_name", "text", (col) => col.notNull().unique())
    .addColumn("certificate_sha256", "text")
    .addColumn("key_object_key", "text")
    .addColumn("key_object_version", "text")
    .addColumn("developer_console_state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("developer_console_error", "text")
    .addColumn("developer_console_provider_state", "text")
    .addColumn("developer_console_check_attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("developer_console_last_checked_at", "timestamptz")
    .addColumn("developer_console_next_check_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("developer_console_last_failure", "text")
    .addColumn("developer_console_claim_token", "text")
    .addColumn("developer_console_claim_expires_at", "timestamptz")
    .addColumn("last_accepted_version_code", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("verified_setup_commit", "text")
    .addColumn("latest_good_deployment_id", "uuid", (col) =>
      col.references("deployment.id").onDelete("set null"),
    )
    .addColumn("last_error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "android_app_package_name_check",
      sql`package_name ~ '^me\\.sproutos\\.app\\.p[0-9a-f]{32}$'`,
    )
    .addCheckConstraint(
      "android_app_certificate_sha256_check",
      sql`certificate_sha256 is null or certificate_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "android_app_developer_console_state_check",
      sql`developer_console_state in ('pending', 'pending_registration', 'registering', 'ownership_required', 'registered', 'failed')`,
    )
    .addCheckConstraint(
      "android_app_provider_state_check",
      sql`developer_console_provider_state is null or developer_console_provider_state in ('NOT_REGISTERED', 'REGISTERED', 'REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT')`,
    )
    .addCheckConstraint(
      "android_app_setup_commit_check",
      sql`verified_setup_commit is null or verified_setup_commit ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "android_app_provider_attempts_check",
      sql`developer_console_check_attempts >= 0`,
    )
    .addCheckConstraint(
      "android_app_claim_shape_check",
      sql`(developer_console_claim_token is null) = (developer_console_claim_expires_at is null)`,
    )
    .addCheckConstraint(
      "android_app_registered_identity_check",
      sql`developer_console_state <> 'registered' or (
        developer_console_provider_state is not distinct from 'REGISTERED'
        and certificate_sha256 is not null
        and key_object_key is not null
        and key_object_version is not null
      )`,
    )
    .addCheckConstraint("android_app_last_version_check", sql`last_accepted_version_code >= 0`)
    .execute()

  await db.schema.alterTable("apk_signing_job").renameTo("android_signer_job").execute()
  await db.schema
    .alterTable("android_signer_job")
    .addColumn("android_app_id", "uuid", (col) =>
      col.references("android_app.id").onDelete("cascade"),
    )
    .addColumn("kind", "text")
    .addColumn("state", "text")
    .addColumn("error", "text")
    .addColumn("version_code", "integer")
    .addColumn("version_name", "text")
    .addColumn("input_mime", "text")
    .addColumn("signed_size_bytes", "bigint")
    .addColumn("signed_object_version", "text")
    .addColumn("callback_idempotency_key", "text")
    .execute()

  await sql`delete from android_signer_job`.execute(db)

  await db.schema
    .alterTable("android_signer_job")
    .dropConstraint("apk_signing_job_deployment_key")
    .execute()
  await db.schema
    .alterTable("android_signer_job")
    .dropConstraint("apk_signing_job_status_check")
    .execute()
  await db.schema
    .alterTable("android_signer_job")
    .alterColumn("deployment_id", (col) => col.dropNotNull())
    .alterColumn("project_id", (col) => col.dropNotNull())
    .alterColumn("unsigned_key", (col) => col.dropNotNull())
    .alterColumn("unsigned_digest", (col) => col.dropNotNull())
    .alterColumn("android_app_id", (col) => col.setNotNull())
    .alterColumn("kind", (col) => col.setNotNull())
    .alterColumn("state", (col) => col.setNotNull())
    .dropColumn("status")
    .dropColumn("last_error")
    .execute()

  await sql`
    alter table android_signer_job
      add constraint android_signer_job_kind_check check (kind in ('provision_key', 'sign_release')),
      add constraint android_signer_job_state_check check (state in ('queued', 'running', 'succeeded', 'failed')),
      add constraint android_signer_job_callback_key_check check (
        callback_idempotency_key is null or callback_idempotency_key ~ '^[0-9a-f]{64}$'
      ),
      add constraint android_signer_job_shape_check check ((
        kind = 'provision_key'
        and deployment_id is null
        and project_id is null
        and unsigned_key is null
        and unsigned_digest is null
        and version_code is null
        and version_name is null
        and input_mime is null
      ) or (
        kind = 'sign_release'
        and deployment_id is not null
        and project_id is not null
        and unsigned_key is not null
        and unsigned_digest ~ '^[0-9a-f]{64}$'
        and version_code > 0
        and input_mime = 'application/vnd.android.package-archive'
      ))
  `.execute(db)

  await sql`drop index if exists apk_signing_job_pending_idx`.execute(db)
  await sql`drop index if exists apk_signing_job_project_id_idx`.execute(db)
  await sql`
    create index android_signer_job_claim_idx
      on android_signer_job (created_at)
      where state = 'queued'
  `.execute(db)
  await sql`
    create unique index android_signer_job_provision_key
      on android_signer_job (android_app_id)
      where kind = 'provision_key'
  `.execute(db)
  await sql`
    create unique index android_signer_job_deployment_key
      on android_signer_job (deployment_id)
      where kind = 'sign_release' and state <> 'failed'
  `.execute(db)
  await sql`
    create unique index android_signer_job_version_key
      on android_signer_job (android_app_id, version_code)
      where kind = 'sign_release' and state <> 'failed'
  `.execute(db)

  await sql`
    create index android_app_registration_due_idx
      on android_app (developer_console_next_check_at)
      where certificate_sha256 is not null
  `.execute(db)

  await db.schema
    .createTable("android_registration_reconciler_state")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("last_completed_at", "timestamptz")
    .addColumn("last_failure", "text")
    .addColumn("terminal_blocked_at", "timestamptz")
    .addColumn("terminal_failure_kind", "text")
    .addColumn("terminal_config_fingerprint", "text")
    .addColumn("quota_provider_date", "date", (col) =>
      col.notNull().defaultTo(sql`(now() at time zone 'America/Los_Angeles')::date`),
    )
    .addColumn("quota_reserved", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "android_registration_reconciler_singleton_check",
      sql`id = 'developer-id-status'`,
    )
    .addCheckConstraint(
      "android_registration_reconciler_quota_check",
      sql`quota_reserved between 0 and 1000`,
    )
    .addCheckConstraint(
      "android_registration_reconciler_terminal_shape_check",
      sql`(terminal_blocked_at is null and terminal_failure_kind is null and terminal_config_fingerprint is null)
        or (terminal_blocked_at is not null
          and terminal_failure_kind in ('invalid_argument', 'unauthenticated', 'permission_denied', 'provider_contract')
          and terminal_config_fingerprint ~ '^[0-9a-f]{64}$')`,
    )
    .execute()

  await sql`
    insert into android_registration_reconciler_state (id)
    values ('developer-id-status')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("android_registration_reconciler_state").execute()
  await sql`
    delete from android_signer_job where kind = 'provision_key';
    drop index if exists android_signer_job_claim_idx;
    drop index if exists android_signer_job_provision_key;
    drop index if exists android_signer_job_deployment_key;
    drop index if exists android_signer_job_version_key;
    alter table android_signer_job
      drop constraint android_signer_job_kind_check,
      drop constraint android_signer_job_state_check,
      drop constraint android_signer_job_callback_key_check,
      drop constraint android_signer_job_shape_check,
      add column status text,
      add column last_error text;
    update android_signer_job set
      status = case state
        when 'queued' then 'pending'
        when 'running' then 'claimed'
        when 'succeeded' then 'signed'
        when 'failed' then 'failed'
      end,
      last_error = error;
    alter table android_signer_job
      alter column status set not null,
      alter column deployment_id set not null,
      alter column project_id set not null,
      alter column unsigned_key set not null,
      alter column unsigned_digest set not null,
      drop column android_app_id,
      drop column kind,
      drop column state,
      drop column error,
      drop column version_code,
      drop column version_name,
      drop column input_mime,
      drop column signed_size_bytes,
      drop column signed_object_version,
      drop column callback_idempotency_key,
      add constraint apk_signing_job_status_check
        check (status in ('pending', 'claimed', 'signed', 'failed')),
      add constraint apk_signing_job_deployment_key unique (deployment_id);
    alter table android_signer_job rename to apk_signing_job;
    create index apk_signing_job_pending_idx on apk_signing_job (created_at)
      where status = 'pending';
    create index apk_signing_job_project_id_idx on apk_signing_job (project_id)
  `.execute(db)
  await db.schema.dropTable("android_app").execute()
}
