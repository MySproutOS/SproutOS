import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("backend_service")
    .addColumn("public_read", "boolean", (col) => col.notNull().defaultTo(false))
    .execute()

  await db.schema
    .alterTable("backend_service")
    .addCheckConstraint(
      "backend_service_public_read_kind_check",
      sql`kind = 'object_storage' or public_read = false`,
    )
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("backend_service")
    .dropConstraint("backend_service_public_read_kind_check")
    .execute()
  await db.schema.alterTable("backend_service").dropColumn("public_read").execute()
}
