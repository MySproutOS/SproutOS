import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Drop the tables that only existed because we ran Neon's storage layer ourselves.
 *
 * `neon_shard_placement` recorded which pageserver held which tenant shard. It existed because a
 * self-hosted storage controller *panics* without a control plane to notify — see ADR 0025. There
 * is no storage controller of ours any more, so the table records nothing.
 *
 * `neon_endpoint` tracked the lifecycle of a compute: suspended, starting, running, its host and
 * port and the container behind it. Neon owns compute now and wakes it on connection, so there is
 * no lifecycle here to track. What survives is `database_branch.provider_branch_id`, which is what
 * the first migration named that column for.
 *
 * Both are dropped rather than left empty. A table nobody writes is a table somebody eventually
 * reads and believes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("neon_endpoint").ifExists().execute()
  await db.schema.dropTable("neon_shard_placement").ifExists().execute()
}

/**
 * Recreated on the way down, because a migration that cannot reverse is a migration nobody dares
 * run. The shapes match what `2026_09_14` and `2026_09_15`/`2026_09_16` created.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("neon_shard_placement")
    .addColumn("tenant_id", "text", (col) => col.notNull())
    .addColumn("shard_number", "int2", (col) => col.notNull())
    .addColumn("node_id", "integer", (col) => col.notNull())
    .addColumn("preferred_az", "text")
    .addColumn("stripe_size", "integer")
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("neon_shard_placement_pkey", ["tenant_id", "shard_number"])
    .execute()

  await db.schema
    .createTable("neon_endpoint")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("backend_service_id", "uuid", (col) =>
      col.references("backend_service.id").onDelete("cascade").notNull(),
    )
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade"),
    )
    .addColumn("tenant_id", "text", (col) => col.notNull())
    .addColumn("timeline_id", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("suspended"))
    .addColumn("host", "text")
    .addColumn("port", "integer")
    .addColumn("runtime_ref", "text")
    .addColumn("role_name", "text")
    .addColumn("database_name", "text")
    .addColumn("last_active_at", "timestamptz")
    .addColumn("started_at", "timestamptz")
    .addColumn("suspended_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("neon_endpoint_timeline_key", ["tenant_id", "timeline_id"])
    .execute()
}
