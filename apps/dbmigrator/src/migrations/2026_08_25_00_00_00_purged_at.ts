import { type Kysely, sql } from "kysely"

/**
 * When a soft delete finished reaching the stores Postgres does not know about.
 *
 * `deleted_at` says a customer asked for something to be gone. It does not say it *is* gone: a
 * tenant's Valkey keys, OpenSearch indices and ClickHouse log rows live outside this database, and
 * the drivers deliberately do not delete them inline — a delete request that waited on shard
 * removal would time out, and a failure halfway would leave the row marked deleted with the data
 * still on disk and nothing scheduled to notice.
 *
 * So a reaper does it out of band, and needs two things this adds: somewhere to record that it
 * finished, and a way to find the rows where it has not. Without the stamp the reaper either
 * re-purges everything on every pass or, worse, is written to purge once and never retried when it
 * fails.
 *
 * Nullable and never defaulted: `null` is the honest state for every row that exists today, all of
 * which predate the reaper.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ["backend_service", "organization"]) {
    await db.schema
      .alterTable(table)
      .addColumn("purged_at", "timestamptz", (col) => col.defaultTo(null))
      .execute()
  }

  /*
    The reaper's work queue, as an index.

    Partial, on `deleted_at` only where the purge has not run, because that is the entire query:
    "deleted, not yet purged, oldest first". A full index on `deleted_at` would carry a row per
    deleted organization forever, and every one of them is a row this query must never see again.
    The partial index empties itself as the reaper works.
  */
  await sql`
    create index backend_service_awaiting_purge_idx
      on backend_service (deleted_at)
      where deleted_at is not null and purged_at is null
  `.execute(db)

  await sql`
    create index organization_awaiting_purge_idx
      on organization (deleted_at)
      where deleted_at is not null and purged_at is null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists organization_awaiting_purge_idx`.execute(db)
  await sql`drop index if exists backend_service_awaiting_purge_idx`.execute(db)
  for (const table of ["organization", "backend_service"]) {
    await db.schema.alterTable(table).dropColumn("purged_at").execute()
  }
}
