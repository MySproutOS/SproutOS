import { BATCH_SIZE, chargeUsage, expireHolds, formatMicroUsd, rollUpUsage } from "@lib/billing"
import { observabilityConfigured } from "@lib/observability"
import { reap, searchAdminConfigFromEnv } from "@lib/reaper"
import { Redis } from "ioredis"
import { type DispatchResult, dispatchQueues, type MasterQueueClient } from "./dispatch"
import { GITHUB_EVENT_HANDLERS, GITHUB_EVENT_KINDS } from "./github-events"
import { TEARDOWN_KIND, tearDownProject } from "./teardown"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { ANALYSIS_KIND, analyzeRepositoryJob } from "./analysis"
import { BUILD_KINDS, buildImage } from "./build"
import { deployRevision, DEPLOY_KINDS } from "./deploy"
import { PROVISION_KIND, provisionProjectJob } from "./provision"
import { enqueue } from "./queue"
import { REGISTRY_CREDENTIAL_KIND, refreshRegistryCredential } from "./registry-credential"
import { WORKFLOW_RUN_KIND, workflowRunJob } from "./workflow-run"
import { sweepExpired } from "./retention"
import { scanForUpkeep, scheduleUpkeepScan, UPKEEP_KINDS } from "./upkeep"
import { upkeepRepository } from "./upkeep-repository"
import type { JobHandler } from "./worker"

/**
 * How many rollup batches one job run works through.
 *
 * Ten thirty-second samples per pod per node adds up: an hour of downtime on a hundred-pod cluster
 * is on the order of a million events. Draining that in one job would hold a transaction open long
 * enough to matter and would starve every other job of a worker. Twenty batches is 100,000 events
 * per run, and the ten-minute schedule catches up on the rest.
 */
const MAX_ROLLUP_BATCHES = 20

/**
 * The ten-minute window a scheduled rollup belongs to, as an idempotency key component.
 *
 * `2026-08-21T02:5` — the hour, plus the tens digit of the minute. Crude on purpose: the recurring
 * scheduler's whole design is that a key collision is how "already scheduled" is expressed, so this
 * needs to be a pure function of the clock and nothing else.
 */
function tenMinuteWindow(now: Date): string {
  return now.toISOString().slice(0, 15)
}

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
  rollUpUsage: "billing.roll_up_usage",
  chargeUsage: "billing.charge_usage",
  purgeExpiredAgentEvents: "agent.purge_events",
  purgeDeletedTenants: "platform.purge_deleted",
  sweepExpired: "platform.retention_sweep",
  upkeepScan: UPKEEP_KINDS.scan,
  upkeepRepository: UPKEEP_KINDS.repository,
  deployRevision: DEPLOY_KINDS.revision,
  buildImage: BUILD_KINDS.image,
  analyzeRepository: ANALYSIS_KIND,
  provisionProject: PROVISION_KIND,
  workflowRun: WORKFLOW_RUN_KIND,
  dispatchQueues: "queue.dispatch",
  refreshRegistryCredential: REGISTRY_CREDENTIAL_KIND,
  tearDownProject: TEARDOWN_KIND,
  /*
    The GitHub webhook kinds, declared here as well as produced there.

    `handlers.test.ts` asserts that every registered handler is under a declared kind — "a handler
    under a kind no caller can enqueue is dead code that reads as coverage". Spreading them in is
    what keeps that true, and `webhooks.ts` builds its dispatch from the same constant, so the
    receiver, the registry and the handlers cannot drift into three spellings of one string.
  */
  ...GITHUB_EVENT_KINDS,
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
 * Fold metered events into the rollups every cost figure is computed from.
 *
 * Runs in a loop until a batch comes back short, because one poll interval of arrears is a cost
 * figure that lags by a poll interval — and after any outage there is a backlog whose size is the
 * outage's length times the whole fleet's sampling rate. Bounded by `MAX_ROLLUP_BATCHES` so a very
 * long backlog is worked down over several runs rather than in one job that never returns.
 */
const rollUpUsageJob: JobHandler = async (_job, { db }) => {
  let events = 0
  for (let batch = 0; batch < MAX_ROLLUP_BATCHES; batch += 1) {
    const result = await rollUpUsage(db)
    events += result.events
    if (result.events < BATCH_SIZE) break
  }
  if (events > 0) console.info(`[jobs] rolled up ${events} usage events`)
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

/**
 * Post the ledger charges for usage that has been rolled up.
 *
 * Separate from `rollUpUsage` rather than folded into it, because the two fail differently and
 * should be retried differently: rolling up is arithmetic over rows this platform wrote, and
 * charging touches balances. A rollup that has to be retried ten times must not post ten charges.
 *
 * Runs after the rollup on the same schedule. `chargeUsage` claims only grains whose quantity
 * exceeds what has already been charged, so ordering between the two is a matter of latency rather
 * than correctness.
 */
const chargeUsageJob: JobHandler = async (_job, { db }) => {
  const result = await chargeUsage(db)
  if (result.rollups > 0) {
    console.info(
      `[jobs] charged ${formatMicroUsd(result.chargedMicroUsd)} across ${result.organizations} organization(s), ${result.rollups} grain(s)`,
    )
  }
}

/**
 * TASK 20's consumer: read the master queue and start or stop workers.
 *
 * The Valkey connection is opened per run and closed after. This runs every ten minutes and holding
 * a connection open between runs would mean one idle connection per worker process for the life of
 * the deployment, against a shared instance where connection slots are the scarce resource.
 */
const dispatchQueuesJob: JobHandler = async (_job, { db }) => {
  const url = process.env.SERVICE_VALKEY_ADMIN_URL ?? process.env.VALKEY_URL
  if (url === undefined || url === "") {
    // Refuses rather than skipping. A dispatcher that quietly does nothing is a queue with a
    // backlog and no worker, which is indistinguishable from a customer's code being broken.
    throw new Error("SERVICE_VALKEY_ADMIN_URL is not set; queue workers cannot be dispatched")
  }

  const redis = new Redis(url)
  try {
    /*
      Adapted rather than passed straight through.

      `ioredis`' `zrange` carries a dozen overloads — `BYSCORE`, `REV`, `LIMIT`, `Buffer` variants —
      and a `Redis` is not assignable to a two-method interface because of them: `stop` is typed
      `string | Buffer`, so a numeric `-1` matches nothing. Going through `call` costs one narrowing
      and keeps `MasterQueueClient` the two commands it actually is, which is also what lets a test
      hand in an object literal.
    */
    const client: MasterQueueClient = {
      zrange: async (key, start, stop, withScores) => {
        const reply = await redis.call("ZRANGE", key, String(start), String(stop), withScores)
        // A `ZRANGE ... WITHSCORES` reply is a flat array of member, score, member, score. Anything
        // else means the command did not do what this thinks it did.
        return Array.isArray(reply) ? (reply as string[]) : []
      },
      zrem: async (key, member) => Number(await redis.call("ZREM", key, member)),
    }

    const result = await dispatchQueues(db, client)
    if (result.seen > 0) {
      console.info(
        `[jobs] dispatch: ${result.seen} queue(s), ${result.started} started, ${result.stopped} stopped` +
          describeUnstartable(result),
      )
    }
  } finally {
    redis.disconnect()
  }
}

/**
 * The queues that could not get a worker, and why — only when there are any.
 *
 * Named rather than counted, because `no-secret` is the one a customer can act on and burying it in
 * a total is how it stops being acted on.
 */
function describeUnstartable(result: DispatchResult): string {
  const reasons = Object.entries(result.unstartable).filter(([, count]) => count > 0)
  if (reasons.length === 0) return ""
  return `, unstartable: ${reasons.map(([reason, count]) => `${count} ${reason}`).join(", ")}`
}

export const PLATFORM_HANDLERS: Record<string, JobHandler> = {
  /*
    The GitHub webhook handlers.

    Spread rather than listed, because the receiver in `webhooks.ts` decides the kinds and this is
    the other side of that contract — `github-events.ts` owns both the names and the work. Five
    kinds were being queued with no handler at all.
  */
  ...GITHUB_EVENT_HANDLERS,
  [JOB_KINDS.refreshRegistryCredential]: refreshRegistryCredential(),
  [JOB_KINDS.expireCreditHolds]: expireCreditHolds,
  [JOB_KINDS.rollUpUsage]: rollUpUsageJob,
  [JOB_KINDS.chargeUsage]: chargeUsageJob,
  [JOB_KINDS.purgeExpiredAgentEvents]: purgeExpiredAgentEvents,
  [JOB_KINDS.purgeDeletedTenants]: purgeDeletedTenants,
  [JOB_KINDS.sweepExpired]: retentionSweep,
  // The day is baked into the handler so a scan that is retried tomorrow keys tomorrow's jobs.
  [JOB_KINDS.upkeepScan]: (job, context) =>
    scanForUpkeep(new Date().toISOString().slice(0, 10))(job, context),
  [JOB_KINDS.upkeepRepository]: upkeepRepository(),
  [JOB_KINDS.deployRevision]: deployRevision(),
  [JOB_KINDS.buildImage]: buildImage(),
  [JOB_KINDS.analyzeRepository]: analyzeRepositoryJob,
  [JOB_KINDS.provisionProject]: provisionProjectJob,
  [JOB_KINDS.dispatchQueues]: dispatchQueuesJob,
  [JOB_KINDS.tearDownProject]: tearDownProject(),
  [JOB_KINDS.workflowRun]: workflowRunJob,
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
    /*
      Every ten minutes, which is far more often than either cloud's credential expires.

      Chosen for the failure it prevents rather than the expiry it tracks. A build that starts
      thirty seconds before the credential lapses compiles the whole application and then fails at
      the push with a 403 that reads like a permissions problem — minutes of billed compute thrown
      away for a Secret that costs one API call to rewrite.
    */
    kind: JOB_KINDS.refreshRegistryCredential,
    idempotencyKey: `${JOB_KINDS.refreshRegistryCredential}:${tenMinuteWindow(now)}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    kind: JOB_KINDS.expireCreditHolds,
    idempotencyKey: `${JOB_KINDS.expireCreditHolds}:${hour}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every ten minutes, not hourly.

      This is the only thing standing between a metered event and a number a customer can see, so
      the interval is how stale the dashboard's cost figure is allowed to be. Hourly would mean a
      project that has been running all afternoon shows an hour-old total, which reads as the
      metering being broken.
    */
    kind: JOB_KINDS.rollUpUsage,
    idempotencyKey: `${JOB_KINDS.rollUpUsage}:${tenMinuteWindow(now)}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every ten minutes too, right behind the rollup.

      The two are separate jobs because they fail differently: rolling up is arithmetic over rows
      this platform wrote, and charging moves balances. A rollup retried ten times must not post ten
      charges, and keeping them apart is what makes each retry policy sane on its own.

      Ordering between them is latency, not correctness. `chargeUsage` claims grains whose quantity
      exceeds what has already been charged, so a grain the rollup writes after the charge has run
      is simply picked up ten minutes later — the same path a late-arriving event takes.
    */
    kind: JOB_KINDS.chargeUsage,
    idempotencyKey: `${JOB_KINDS.chargeUsage}:${tenMinuteWindow(now)}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every ten minutes, which is the resolution of the whole scale-from-zero decision.

      Faster would not help: the proxy batches wakes for a second and `IDLE_MS` is ten minutes, so a
      queue that goes active is served within one interval and one that goes quiet is stopped after
      ten. The thing this trades against is a job's first-run latency after a lull, which is why
      `IDLE_MS` is generous rather than this being frequent.
    */
    kind: JOB_KINDS.dispatchQueues,
    idempotencyKey: `${JOB_KINDS.dispatchQueues}:${tenMinuteWindow(now)}`,
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
