import { expireHolds } from "@lib/billing"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { enqueue } from "./queue"
import { scanForUpkeep, scheduleUpkeepScan, UPKEEP_KINDS } from "./upkeep"
import type { JobHandler } from "./worker"

/**
 * The job kinds the platform ships with.
 *
 * Both of these were promised by earlier work and had nothing running them: the holds design says
 * an abandoned reservation is freed by a reaper, and `agent_event.expires_at` defaults to 30 days
 * on a table that holds customer source code. A default that nothing enforces is a retention
 * policy in name only.
 */
export const JOB_KINDS = {
  expireCreditHolds: "billing.expire_holds",
  purgeExpiredAgentEvents: "agent.purge_events",
  upkeepScan: UPKEEP_KINDS.scan,
  upkeepRepository: UPKEEP_KINDS.repository,
} as const

/**
 * Free reservations whose runner never came back.
 *
 * `availableBalance` subtracts active holds, so a hold nobody closed is a customer's money made
 * unspendable by a process that no longer exists. Charges nothing — see `expireHolds`.
 */
const expireCreditHolds: JobHandler = async (_job, { db }) => {
  const expired = await expireHolds(db)
  if (expired > 0) console.info(`[jobs] expired ${expired} credit holds`)
}

/**
 * Delete agent transcripts past their retention date.
 *
 * `agent_event.payload` holds tool calls and file contents from a customer's repository. The
 * 30-day `expires_at` default is the promise; this is the only thing that keeps it. Deleted in
 * bounded batches so a long-neglected table cannot produce a single statement that locks the
 * partition for minutes.
 */
const purgeExpiredAgentEvents: JobHandler = async (_job, { db }) => {
  let deleted = 0
  for (let batch = 0; batch < 20; batch++) {
    const result = await db
      .deleteFrom("agentEvent")
      .where((eb) =>
        eb(
          "id",
          "in",
          eb
            .selectFrom("agentEvent as expired")
            .select("expired.id")
            .where("expired.expiresAt", "<", sql<Date>`now()`)
            .limit(1000),
        ),
      )
      .executeTakeFirst()

    const rows = Number(result.numDeletedRows)
    deleted += rows
    if (rows === 0) break
  }

  if (deleted > 0) console.info(`[jobs] purged ${deleted} expired agent events`)
}

export const PLATFORM_HANDLERS: Record<string, JobHandler> = {
  [JOB_KINDS.expireCreditHolds]: expireCreditHolds,
  [JOB_KINDS.purgeExpiredAgentEvents]: purgeExpiredAgentEvents,
  // The day is baked into the handler so a scan that is retried tomorrow keys tomorrow's jobs.
  [JOB_KINDS.upkeepScan]: (job, context) =>
    scanForUpkeep(new Date().toISOString().slice(0, 10))(job, context),
}

/**
 * Keep the recurring jobs scheduled.
 *
 * There is no cron table and no second scheduler: a recurring job is a row whose idempotency key
 * names the window it belongs to. Calling this repeatedly is free — the key collides and nothing
 * is inserted — so any worker can call it on every poll without coordination.
 */
export async function scheduleRecurring(db: Kysely<DB>, now: Date = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13)

  await enqueue(db, {
    kind: JOB_KINDS.expireCreditHolds,
    idempotencyKey: `${JOB_KINDS.expireCreditHolds}:${hour}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    kind: JOB_KINDS.purgeExpiredAgentEvents,
    idempotencyKey: `${JOB_KINDS.purgeExpiredAgentEvents}:${now.toISOString().slice(0, 10)}`,
    maxAttempts: 3,
  })
  await scheduleUpkeepScan(db, now)
}
