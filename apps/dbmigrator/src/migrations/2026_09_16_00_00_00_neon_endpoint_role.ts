import type { Kysely } from "kysely"

/**
 * The tenant's role and database, carried on the endpoint.
 *
 * `compute_ctl` creates both from the spec on every start, so they have to be *declared* rather than
 * created once — a suspended endpoint has no Postgres to run `create role` against. Without this the
 * only place to put them would be a compute that has to be woken to be provisioned, and woken again
 * on first use, which is the cost the whole design exists to avoid.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("neon_endpoint").addColumn("role_name", "text").execute()
  await db.schema.alterTable("neon_endpoint").addColumn("database_name", "text").execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("neon_endpoint").dropColumn("role_name").execute()
  await db.schema.alterTable("neon_endpoint").dropColumn("database_name").execute()
}
