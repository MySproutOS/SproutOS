import { sql, type Kysely } from "kysely"

/**
 * Every Neon branch created for an agent must keep an owner until it is deleted.
 *
 * `sandbox.database_branch_id` remains the sandbox's default `DATABASE_URL`. This table contains
 * that branch and every additional branch requested during a turn, so sandbox destruction and the
 * expiry reaper have one complete ownership set rather than one privileged pointer plus orphans.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sandbox_database_branch")
    .addColumn("sandbox_id", "uuid", (col) =>
      col.references("sandbox.id").onDelete("cascade").notNull(),
    )
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade").notNull(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("sandbox_database_branch_pkey", ["sandbox_id", "database_branch_id"])
    .addUniqueConstraint("sandbox_database_branch_branch_key", ["database_branch_id"])
    .execute()

  await db.schema
    .createIndex("sandbox_database_branch_sandbox_id_idx")
    .on("sandbox_database_branch")
    .column("sandbox_id")
    .execute()

  await sql`
    insert into sandbox_database_branch (sandbox_id, database_branch_id)
    select id, database_branch_id
    from sandbox
    where database_branch_id is not null
    on conflict do nothing
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sandbox_database_branch").execute()
}
