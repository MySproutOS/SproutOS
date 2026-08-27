import { sql, type Kysely } from "kysely"

/**
 * A sandbox gets its own database branch, and a credential that can only reach it.
 *
 * Two things stood in the way of the environment a coding agent is supposed to work in.
 *
 * **One live credential per `(username, purpose)`.** The username is derived from the *service*, so
 * a branch credential shares it with the primary — that is deliberate, and the Rust store handles
 * it: it fetches every live credential for the username and tells them apart by which secret
 * verifies, then carries `database_branch_id` off the row that matched. What it could not handle
 * was two of them existing, because the live index forbade it. The index now includes the branch,
 * so a service can have its primary credential and one per ephemeral branch, and still cannot have
 * two credentials meaning the same thing.
 *
 * `coalesce` rather than a partial index on `database_branch_id is null`: a null in a unique index
 * is distinct from every other null, so without it the primary credential's own uniqueness — the
 * invariant that existed before ephemeral branches — would quietly stop being enforced.
 *
 * **Nothing recorded which branch a sandbox owns.** Without it a sandbox is destroyed and its Neon
 * branch stays, storing data and costing money, with nothing left pointing at it. `on delete set
 * null` because the branch reaper may get there first, and a sandbox row outliving its branch is
 * ordinary rather than an error.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop index service_credential_live_username_purpose_key`.execute(db)
  await sql`
    create unique index service_credential_live_username_purpose_branch_key
      on service_credential (
        username,
        purpose,
        coalesce(database_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
      where revoked_at is null
  `.execute(db)

  await db.schema
    .alterTable("sandbox")
    .addColumn("database_branch_id", "uuid", (col) =>
      col.references("database_branch.id").onDelete("set null"),
    )
    .execute()

  await db.schema
    .createIndex("sandbox_database_branch_id_idx")
    .on("sandbox")
    .column("database_branch_id")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("sandbox_database_branch_id_idx").execute()
  await db.schema.alterTable("sandbox").dropColumn("database_branch_id").execute()

  /*
    Branch credentials cannot exist under the old index — a second live row for a username is
    exactly what it forbids — so they are revoked rather than left to break the index creation.
    The branches themselves survive; a revoked credential is a sandbox that cannot reach its dev
    database, which is recoverable, and a failed migration is not.
  */
  await sql`
    update service_credential set revoked_at = now()
    where database_branch_id is not null and revoked_at is null
  `.execute(db)

  await sql`drop index service_credential_live_username_purpose_branch_key`.execute(db)
  await sql`
    create unique index service_credential_live_username_purpose_key
      on service_credential (username, purpose)
      where revoked_at is null
  `.execute(db)
}
