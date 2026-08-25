import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * A watermark for sandbox metering, because windows cannot answer the question.
 *
 * `sandbox.meter` bills wall-clock time a sandbox spent running. The obvious shape is a fixed
 * ten-minute window, keyed for idempotency the way `billing.roll_up_usage` keys its own — but that
 * needs to know whether a sandbox was running *during* a window that has already passed, and the
 * `sandbox` row only records what is true now. A sandbox that started and stopped between two runs
 * of the job would be billed for all of both windows, or for neither, depending on which way the
 * guess went. Neither is recoverable afterwards, because the evidence was never written down.
 *
 * `metered_through` is the last instant already billed. A run meters `[metered_through, now)` and
 * advances it in the same statement that records the usage, so:
 *
 * - a retry after a crash re-meters the same interval and the ingest's
 *   `(source, external_id, occurred_at)` conflict clause drops the duplicate;
 * - a stop mid-interval settles the tail exactly rather than rounding to a window;
 * - a job that does not run for an hour bills the hour, rather than the ten minutes it can see.
 *
 * Null means never metered, which is not the same as "metered up to the beginning of time" — the
 * first run reads `coalesce(metered_through, created_at)` so a fresh sandbox bills from when it was
 * created rather than from the epoch. That difference is about forty years of free compute in one
 * direction and a very large invoice in the other.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sandbox").addColumn("metered_through", "timestamptz").execute()

  /*
    Rows that already exist have never been metered and must not now be billed for the time they
    spent existing before there was anything to bill them. Set to `now()`, so metering starts here.
  */
  await sql`update sandbox set metered_through = now()`.execute(db)

  /*
    The job scans for sandboxes with time owed. Partial on the states that accrue: a stopped sandbox
    still holds disk, but disk is billed through the same path only while the row says it is running
    — see the handler for why a stopped sandbox is settled once rather than metered forever.
  */
  await sql`
    create index sandbox_meter_idx on sandbox (metered_through)
      where state in ('starting', 'running', 'idle')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists sandbox_meter_idx`.execute(db)
  await db.schema.alterTable("sandbox").dropColumn("metered_through").execute()
}
