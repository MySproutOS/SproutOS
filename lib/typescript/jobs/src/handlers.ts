import { expireHolds } from "@lib/billing"
import { observabilityConfigured } from "@lib/observability"
import { reap, searchAdminConfigFromEnv } from "@lib/reaper"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { ANALYSIS_KIND, analyzeRepositoryJob } from "./analysis"
import { enqueue } from "./queue"
import { sweepExpired } from "./retention"
import { scanForUpkeep, scheduleUpkeepScan, UPKEEP_KINDS } from "./upkeep"
import { upkeepRepository } from "./upkeep-repository"
import type { JobHandler } from "./worker"

/**
 * The job kinds the platform ships with.
 *
 * Every one of them exists because something earlier promised a thing and left nothing to do it:
 * the holds design says an abandoned reservation is freed by a reaper, `agent_event.expires_at`
 * defaults to 30 days on a table that holds customer source code, and `destroy` marks a service
 * deleted without deleting anything outside Postgres. A default that nothing enforces is a
 * retention policy in name only, and a delete that nothing finishes is worse than that.
 */
export const JOB_KINDS = {
  expireCreditHolds: "billing.expire_holds",
  purgeExpiredAgentEvents: "agent.purge_events",
  purgeDeletedTenants: "platform.purge_deleted",
  sweepExpired: "platform.retention_sweep",
  upkeepScan: UPKEEP_KINDS.scan,
  upkeepRepository: UPKEEP_KINDS.repository,
  analyzeRepository: ANALYSIS_KIND,
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

/**
 * Finish the deletions Postgres cannot cascade.
 *
 * Configuration is read here rather than at module load so a deployment without a search cluster —
 * or without ClickHouse — still starts. What it must never do is silently skip the work: a missing
 * `SEARCH_ADMIN_URL` throws, the job fails, and the failure is visible in `background_job`. Logs
 * are the one part with a safe fallback, because `log_record` has a per-row TTL and will empty
 * itself; indices and keys have nothing of the kind.
 */
const purgeDeletedTenants: JobHandler = async (_job, { db }) => {
  const valkeyUrl = process.env.SERVICE_VALKEY_ADMIN_URL ?? process.env.VALKEY_URL
  if (valkeyUrl === undefined || valkeyUrl === "") {
    throw new Error("SERVICE_VALKEY_ADMIN_URL is not set; deleted tenant keys cannot be reaped")
  }

  const report = await reap(db, {
    valkeyUrl,
    search: searchAdminConfigFromEnv(),
    logs: observabilityConfigured(),
  })

  if (report.services.length > 0 || report.organizations.length > 0) {
    const removed = report.services.reduce((total, service) => total + service.removed, 0)
    console.info(
      `[jobs] purged ${report.services.length} deleted services (${removed} keys/indices) and ${report.organizations.length} organizations`,
    )
  }
}

/**
 * Delete the rows whose retention window has closed.
 *
 * One job for seven tables, because they share one policy — see `retention.ts`. Splitting them
 * would mean seven schedules to keep in step and seven places for one of them to quietly stop.
 */
const retentionSweep: JobHandler = async (_job, { db }) => {
  const swept = await sweepExpired(db)
  for (const { label, deleted } of swept) console.info(`[jobs] retention: ${deleted} ${label}`)
}

export const PLATFORM_HANDLERS: Record<string, JobHandler> = {
  [JOB_KINDS.expireCreditHolds]: expireCreditHolds,
  [JOB_KINDS.purgeExpiredAgentEvents]: purgeExpiredAgentEvents,
  [JOB_KINDS.purgeDeletedTenants]: purgeDeletedTenants,
  [JOB_KINDS.sweepExpired]: retentionSweep,
  // The day is baked into the handler so a scan that is retried tomorrow keys tomorrow's jobs.
  [JOB_KINDS.upkeepScan]: (job, context) =>
    scanForUpkeep(new Date().toISOString().slice(0, 10))(job, context),
  [JOB_KINDS.upkeepRepository]: upkeepRepository(),
  [JOB_KINDS.analyzeRepository]: analyzeRepositoryJob,
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
  await enqueue(db, {
    kind: JOB_KINDS.purgeDeletedTenants,
    idempotencyKey: `${JOB_KINDS.purgeDeletedTenants}:${hour}`,
    // Retried more than the others: this one talks to three systems we do not run in-process, and
    // a transient cluster error is the expected failure rather than a surprising one.
    maxAttempts: 5,
  })
  await enqueue(db, {
    // Daily, not hourly. Nothing here is urgent — a row that outlives its window by a few hours has
    // harmed nobody — and a nightly sweep is one lock contention with the tables it deletes from
    // rather than twenty-four.
    kind: JOB_KINDS.sweepExpired,
    idempotencyKey: `${JOB_KINDS.sweepExpired}:${now.toISOString().slice(0, 10)}`,
    maxAttempts: 3,
  })
  await scheduleUpkeepScan(db, now)
}
