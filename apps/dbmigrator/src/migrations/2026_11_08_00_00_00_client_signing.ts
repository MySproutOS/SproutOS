import { type Kysely, sql } from "kysely"

/**
 * The catalogue client has one platform-owned signing identity and an append-only job history.
 * Keeping this separate from customer android_app rows avoids inventing a tenant project for the
 * store itself, while the immutable object versions make every published release reproducible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("upload_idempotency_key", "text")
    .addColumn("callback_idempotency_key", "text")
    .addColumn("callback_kind", "text")
    .addColumn("callback_signer_id", "text")
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
      "client_signer_job_idempotency_check",
      sql`(upload_idempotency_key is null or upload_idempotency_key ~ '^[0-9a-f]{64}$')
        and (
          (callback_idempotency_key is null and callback_kind is null and callback_signer_id is null)
          or (
            callback_idempotency_key ~ '^[0-9a-f]{64}$'
            and callback_kind in ('complete', 'fail')
            and length(callback_signer_id) between 1 and 200
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
}
