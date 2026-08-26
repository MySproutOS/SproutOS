import type { Kysely } from "kysely"

/**
 * A tenant credential that points at a branch rather than the primary.
 *
 * `database_branch` has had `kind in ('primary','dev','upkeep','preview')`, an `expires_at` and a
 * reaper index since the schema was written — ephemeral branches were designed for. Nothing could
 * reach one: `pg-resolve` filtered `kind = 'primary'` unconditionally, so a branch could be created
 * and then had no way of being connected to.
 *
 * The missing piece is here rather than in the resolve route, because the proxy identifies a
 * connection by *credential* and everything downstream follows from that. A credential naming a
 * branch is also the right security shape: an agent working in an ephemeral environment gets a
 * credential that can only ever reach its own branch, so a leaked development credential is not a
 * production database.
 *
 * Null means the primary branch, which keeps every credential that already exists meaning exactly
 * what it meant before this migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("service_credential")
    /*
      `cascade`, unusually.

      The repository's habit is `restrict` on anything that matters, and the opposite is right here:
      a credential that can only reach one branch is meaningless once that branch is gone, and
      leaving it behind would be a live credential resolving to nothing — which the proxy reports as
      an authentication failure, the least informative possible answer. The branch reaper deletes
      ephemeral branches on a timer, and the credentials must go with them.
    */
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("cascade"),
    )
    .execute()

  await db.schema
    .createIndex("service_credential_database_branch_id_idx")
    .on("service_credential")
    .column("database_branch_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("service_credential_database_branch_id_idx").execute()
  await db.schema.alterTable("service_credential").dropColumn("database_branch_id").execute()
}
