import { sql, type Kysely } from "kysely"

/**
 * Stop presenting unmeasured queue residency as an observed zero.
 *
 * Neither column has ever had a writer. Existing zeroes therefore mean "unknown", not "measured
 * and empty", and the schema must be able to retain that distinction until the Valkey meter lands.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workflow_run
      alter column bytes_enqueued drop default,
      alter column bytes_enqueued drop not null,
      alter column valkey_dwell_ms drop default,
      alter column valkey_dwell_ms drop not null
  `.execute(db)
  await sql`
    update workflow_run
       set bytes_enqueued = null,
           valkey_dwell_ms = null
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update workflow_run
       set bytes_enqueued = coalesce(bytes_enqueued, 0),
           valkey_dwell_ms = coalesce(valkey_dwell_ms, 0)
     where bytes_enqueued is null
        or valkey_dwell_ms is null
  `.execute(db)
  await sql`
    alter table workflow_run
      alter column bytes_enqueued set default 0,
      alter column bytes_enqueued set not null,
      alter column valkey_dwell_ms set default 0,
      alter column valkey_dwell_ms set not null
  `.execute(db)
}
