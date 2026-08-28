import { type Kysely, sql } from "kysely"

/** Durable Android developer verification state and reconciler observability. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("android_developer_registration")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("project_id", "uuid", (col) =>
      col.references("project.id").onDelete("cascade").notNull().unique(),
    )
    .addColumn("package_name", "text", (col) => col.notNull().unique())
    .addColumn("certificate_sha256", "text", (col) => col.notNull())
    .addColumn("verified_setup_commit", "text")
    .addColumn("state", "text", (col) => col.notNull().defaultTo("pending_registration"))
    .addColumn("provider_state", "text")
    .addColumn("check_attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_checked_at", "timestamptz")
    .addColumn("next_check_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("last_failure", "text")
    .addColumn("claimed_by", "text")
    .addColumn("claimed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "android_developer_registration_package_name_check",
      sql`package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'`,
    )
    .addCheckConstraint(
      "android_developer_registration_certificate_check",
      sql`certificate_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      "android_developer_registration_setup_commit_check",
      sql`verified_setup_commit is null or verified_setup_commit ~ '^[0-9a-f]{40}$'`,
    )
    .addCheckConstraint(
      "android_developer_registration_state_check",
      sql`state in ('pending_registration', 'registered', 'failed')`,
    )
    .addCheckConstraint(
      "android_developer_registration_provider_state_check",
      sql`provider_state is null or provider_state in ('NOT_REGISTERED', 'REGISTERED', 'REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT')`,
    )
    .addCheckConstraint("android_developer_registration_attempts_check", sql`check_attempts >= 0`)
    .addCheckConstraint(
      "android_developer_registration_registered_check",
      sql`state <> 'registered' or provider_state is not distinct from 'REGISTERED'`,
    )
    .execute()

  await sql`
    create index android_developer_registration_due_idx
      on android_developer_registration (next_check_at)
      where state <> 'registered'
  `.execute(db)

  await db.schema
    .createTable("android_registration_reconciler_state")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("last_completed_at", "timestamptz")
    .addColumn("last_failure", "text")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "android_registration_reconciler_singleton_check",
      sql`id = 'developer-id-status'`,
    )
    .execute()

  await sql`
    insert into android_registration_reconciler_state (id)
    values ('developer-id-status')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("android_registration_reconciler_state").execute()
  await db.schema.dropTable("android_developer_registration").execute()
}
