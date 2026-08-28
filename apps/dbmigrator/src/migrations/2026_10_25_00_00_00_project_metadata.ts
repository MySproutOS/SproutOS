import { type Kysely, sql } from "kysely"

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("project")
    .addColumn("description", "text")
    .addColumn("primary_child_project_id", "uuid", (col) =>
      col.references("project.id").onDelete("set null"),
    )
    .execute()

  await sql`
    alter table project add constraint project_primary_child_group_check
      check (is_group or primary_child_project_id is null)
  `.execute(db)

  await db.schema
    .createIndex("project_primary_child_project_id_idx")
    .on("project")
    .column("primary_child_project_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("project_primary_child_project_id_idx").execute()
  await db.schema
    .alterTable("project")
    .dropColumn("primary_child_project_id")
    .dropColumn("description")
    .execute()
}
