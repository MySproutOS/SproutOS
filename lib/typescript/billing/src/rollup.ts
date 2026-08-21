import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * Turning metered events into the rollups everything else bills from.
 *
 * **This step did not exist.** `apps/internal-api/src/v1/metering.ts` writes `usage_event`, and
 * `billing/src/usage.ts` and the billing routes read `usage_rollup` — and nothing in the repository
 * wrote a single row into the table between them. The comment in the ingest route described "a job
 * that reads `rated_at IS NULL`"; there was no such job, no such job kind, and nothing anywhere set
 * `rated_at` on a usage event. The index built for that query, `usage_event_unrated_idx`, had never
 * been used by anything.
 *
 * The visible symptom is the worst kind: every project's cost rendered as `$0.00`, forever, no
 * matter what it consumed. Nothing errored, no page was blank, and no test failed — the dashboard
 * simply reported that a busy account owed nothing.
 */

/** The grains `usage_rollup` carries, and what each is for. */
export const BUCKETS = [
  // Minute — the live "what is this costing me right now" figure on a project page. Retained
  // briefly; a month of per-minute rows per dimension per project is not worth its storage.
  "minute",
  // Hour — usage graphs and anomaly checks.
  "hour",
  // Day — what a monthly statement is summed from. `rateProjectsForOrganization` reads this grain
  // and only this grain, precisely because summing across all three would triple every bill.
  "day",
] as const

export type Bucket = (typeof BUCKETS)[number]

/**
 * How long an event is allowed to be late before its bucket is considered closed.
 *
 * The agent buffers and retries, so an event can arrive minutes after it happened. Rolling a bucket
 * up the instant its window ends would miss those, and because `rated_at` is set in the same
 * transaction, a missed event is missed permanently: it would never be selected again.
 *
 * Five minutes is longer than the agent's retry buffer and shorter than anyone's patience for a
 * cost figure to appear.
 */
export const LATE_ARRIVAL_GRACE_MS = 5 * 60 * 1000

/** How many events one run consumes. Bounded so a long outage cannot produce a single statement
 *  that holds a lock on the partitioned table for minutes. */
export const BATCH_SIZE = 5_000

export type RollupResult = {
  /** Events consumed. Zero means there was nothing closed and unrated to do. */
  events: number
  /** Rollup rows created or incremented. Roughly `events / 3` grouped, times three buckets. */
  rollups: number
}

/**
 * Roll every closed, unrated `usage_event` into `usage_rollup`, once.
 *
 * One statement per grain rather than reading rows into the process and writing them back. The
 * arithmetic is a `sum()` and the target is an upsert; pulling five thousand rows over the wire to
 * add numbers to them is work Postgres will do better, and it keeps the whole operation inside one
 * transaction without holding rows in memory.
 *
 * **`rated_at` is set in the same transaction as the upsert.** That is what makes this exactly-once
 * rather than at-least-once: a crash between the two would otherwise double-count a customer's
 * usage on the retry, and the job runner retries by design. The unique index
 * `usage_rollup_grain_key` makes the upsert itself idempotent, but the addition inside it is not —
 * `quantity = quantity + excluded.quantity` applied twice is twice the bill.
 */
export async function rollUpUsage(
  db: Kysely<DB>,
  now: Date = new Date(),
  batchSize: number = BATCH_SIZE,
): Promise<RollupResult> {
  const closedBefore = new Date(now.getTime() - LATE_ARRIVAL_GRACE_MS)

  return await db.transaction().execute(async (trx) => {
    /*
      Claimed with `FOR UPDATE SKIP LOCKED`, the same discipline the job runner itself uses. Two
      workers running this concurrently is not a design goal, but it is a thing that happens during
      a rolling deploy — and without the lock they would both select the same events, both add them,
      and both set `rated_at`, producing a bill twice the size with no error anywhere.
    */
    const claimed = await sql<{ id: string }>`
      select id from usage_event
      where rated_at is null and occurred_at < ${closedBefore}
      order by occurred_at
      limit ${batchSize}
      for update skip locked
    `.execute(trx)

    if (claimed.rows.length === 0) return { events: 0, rollups: 0 }

    const ids = claimed.rows.map((row) => row.id)

    let rollups = 0
    for (const bucket of BUCKETS) {
      /*
        Grouped in Postgres, inserted from here.

        The arithmetic is a `sum()` over five thousand rows and belongs in the database. The *ids*
        do not: this repository mints UUIDv7 in the application (`AGENTS.md`), and `v7()` per group
        keeps rollup ids sortable by creation the way every other table's are. Reaching for
        `gen_random_uuid()` inside the insert would be one statement instead of two and would put a
        v4 in a column every neighbouring row has a v7 in.

        The group count is small — five thousand events collapse to a few hundred grains — so the
        extra round trip costs nothing measurable.
      */
      const truncated =
        bucket === "minute"
          ? sql<Date>`date_trunc('minute', occurred_at)`
          : bucket === "hour"
            ? sql<Date>`date_trunc('hour', occurred_at)`
            : sql<Date>`date_trunc('day', occurred_at)`

      const groups = await sql<{
        organizationId: string
        projectId: string | null
        dimension: string
        bucketStart: Date
        quantity: string
      }>`
        select
          organization_id as "organizationId",
          project_id as "projectId",
          dimension,
          ${truncated} as "bucketStart",
          -- As text: numeric(38,9) does not fit a JavaScript number and pg hands back a string
          -- anyway, so naming it here stops anything downstream treating it as one. (No backticks
          -- in these comments: this is a tagged template literal, and one would end it.)
          sum(quantity)::text as quantity
        from usage_event
        where id = any(${ids}::uuid[])
        group by organization_id, project_id, dimension, ${truncated}
      `.execute(trx)

      if (groups.rows.length === 0) continue

      await trx
        .insertInto("usageRollup")
        .values(
          groups.rows.map((group) => ({
            id: v7(),
            organizationId: group.organizationId,
            projectId: group.projectId,
            dimension: group.dimension,
            bucket,
            bucketStart: group.bucketStart,
            quantity: group.quantity,
          })),
        )
        /*
          `nulls not distinct` on `usage_rollup_grain_key` is what makes this work for a standalone
          backend service, whose `project_id` is null. Under the default `nulls distinct`, every
          run would insert a *new* row for the same grain instead of adding to the existing one, and
          an organization's project-less usage would fan out into thousands of duplicates that the
          monthly sum would then add together — inflating the bill rather than losing it.
        */
        .onConflict((oc) =>
          oc
            .columns(["organizationId", "projectId", "dimension", "bucket", "bucketStart"])
            .doUpdateSet({
              quantity: sql`usage_rollup.quantity + excluded.quantity`,
              updatedAt: now,
            }),
        )
        .execute()

      rollups += groups.rows.length
    }

    await sql`
      update usage_event set rated_at = ${now} where id = any(${ids}::uuid[])
    `.execute(trx)

    return { events: ids.length, rollups }
  })
}
