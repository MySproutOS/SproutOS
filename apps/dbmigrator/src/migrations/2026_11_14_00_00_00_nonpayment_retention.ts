import { sql, type Kysely } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("credit_retention_state")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("warning_stage", "text", (col) => col.notNull().defaultTo("safe"))
    .addColumn("generation", "uuid")
    .addColumn("deletion_started_at", "timestamptz")
    .addColumn("deletion_completed_at", "timestamptz")
    .addColumn("reserve_measured_at", "timestamptz")
    .execute()
  await db.schema
    .alterTable("credit_retention_state")
    .addCheckConstraint(
      "credit_retention_status_check",
      sql`status in ('active', 'suspended', 'deleting', 'data_deleted')`,
    )
    .execute()
  await db.schema
    .alterTable("credit_retention_state")
    .addCheckConstraint(
      "credit_retention_warning_stage_check",
      sql`warning_stage in ('safe', 'warning', 'critical', 'suspended', 'deletion_imminent', 'deleting', 'data_deleted')`,
    )
    .execute()

  await db.schema.alterTable("project_job").addColumn("deletion_reason", "text").execute()
  await db.schema.alterTable("project_job").addColumn("service_cutoff_at", "timestamptz").execute()
  await db.schema
    .alterTable("project_job")
    .addColumn("retention_cutoff_at", "timestamptz")
    .execute()
  await db.schema
    .alterTable("project_job")
    .addCheckConstraint(
      "project_job_deletion_reason_check",
      sql`deletion_reason is null or deletion_reason in ('user_requested', 'nonpayment')`,
    )
    .execute()

  await db.schema
    .createTable("retention_notice_delivery")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.references("organization.id").onDelete("cascade").notNull(),
    )
    .addColumn("generation", "uuid", (col) => col.notNull())
    .addColumn("stage", "text", (col) => col.notNull())
    .addColumn("user_id", "uuid", (col) => col.references("user.id").onDelete("set null"))
    .addColumn("recipient", sql`citext`, (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("sent_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("retention_notice_delivery_once", [
      "organization_id",
      "generation",
      "stage",
      "recipient",
    ])
    .addCheckConstraint(
      "retention_notice_delivery_stage_check",
      sql`stage in ('critical', 'suspended', 'deletion_imminent', 'reprieved', 'data_deleted')`,
    )
    .addCheckConstraint(
      "retention_notice_delivery_status_check",
      sql`status in ('pending', 'sending', 'sent', 'failed')`,
    )
    .execute()
  await db.schema
    .createIndex("retention_notice_delivery_pending_idx")
    .on("retention_notice_delivery")
    .columns(["status", "created_at"])
    .where("status", "in", ["pending", "failed"])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("retention_notice_delivery").execute()
  await db.schema
    .alterTable("project_job")
    .dropConstraint("project_job_deletion_reason_check")
    .execute()
  await db.schema
    .alterTable("project_job")
    .dropColumn("retention_cutoff_at")
    .dropColumn("service_cutoff_at")
    .dropColumn("deletion_reason")
    .execute()
  await db.schema
    .alterTable("credit_retention_state")
    .dropConstraint("credit_retention_warning_stage_check")
    .execute()
  await db.schema
    .alterTable("credit_retention_state")
    .dropConstraint("credit_retention_status_check")
    .execute()
  await db.schema
    .alterTable("credit_retention_state")
    .dropColumn("reserve_measured_at")
    .dropColumn("deletion_completed_at")
    .dropColumn("deletion_started_at")
    .dropColumn("generation")
    .dropColumn("warning_stage")
    .dropColumn("status")
    .execute()
}
