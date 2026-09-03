import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("managed_custom_domain_policy")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("suffix", "text", (col) => col.notNull())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("restrict").notNull(),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("created_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict").notNull(),
    )
    .addColumn("updated_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict").notNull(),
    )
    .addColumn("disabled_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict"),
    )
    .addColumn("deleted_by_user_id", "uuid", (col) =>
      col.references("user.id").onDelete("restrict"),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("disabled_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .addCheckConstraint(
      "managed_custom_domain_policy_status_check",
      sql`status in ('active', 'disabled')`,
    )
    .addCheckConstraint(
      "managed_custom_domain_policy_disabled_pair_check",
      sql`(disabled_at is null) = (disabled_by_user_id is null)`,
    )
    .addCheckConstraint(
      "managed_custom_domain_policy_deleted_pair_check",
      sql`(deleted_at is null) = (deleted_by_user_id is null)`,
    )
    .execute()

  await sql`
    create unique index managed_custom_domain_policy_suffix_live_key
      on managed_custom_domain_policy (suffix) where deleted_at is null
  `.execute(db)
  await sql`
    create index managed_custom_domain_policy_organization_idx
      on managed_custom_domain_policy (organization_id) where deleted_at is null
  `.execute(db)

  await db.schema
    .alterTable("custom_domain")
    .addColumn("managed_domain_policy_id", "uuid", (col) =>
      col.references("managed_custom_domain_policy.id").onDelete("restrict"),
    )
    .execute()
  await sql`
    create index custom_domain_managed_policy_idx on custom_domain (managed_domain_policy_id)
      where deleted_at is null and managed_domain_policy_id is not null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("custom_domain").dropColumn("managed_domain_policy_id").execute()
  await db.schema.dropTable("managed_custom_domain_policy").execute()
}
