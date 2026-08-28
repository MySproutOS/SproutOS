import {
  applyImportedUsageRollups,
  chargeUsage,
  expireHolds,
  formatMicroUsd,
  importedUsageCursor,
} from "@lib/billing"
import {
  clickhouseUsageWatermark,
  observabilityConfigured,
  usageRollupsChangedBetween,
} from "@lib/observability"
import {
  reap,
  reconcileSearchSecurity,
  reconcileValkeyAcl,
  SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT,
  VALKEY_ACL_CARDINALITY_SOFT_LIMIT,
  searchAdminConfigFromEnv,
} from "@lib/reaper"
import { GITHUB_EVENT_HANDLERS, GITHUB_EVENT_KINDS } from "./github-events"
import { TEARDOWN_KIND, tearDownProject } from "./teardown"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { ANALYSIS_KIND, analyzeRepositoryJob } from "./analysis"
import { cleanUpStaticPreview, PUBLISH_KINDS, publishRelease, tearDownPreview } from "./publish"
import { REFRESH_ROUTES_KIND, refreshRoutes } from "./refresh-routes"
import { PROVISION_KIND, provisionProjectJob } from "./provision"
import {
  destroySandbox,
  reconcileSandboxes,
  meterSandboxes,
  provisionSandbox,
  reapSandboxes,
  SANDBOX_KINDS,
  scheduleSandboxJobs,
  startSandbox,
  stopSandbox,
} from "./sandbox"
import { enqueue } from "./queue"
import { WORKFLOW_RUN_KIND, workflowRunJob } from "./workflow-run"
import { runDueWorkflowSchedules } from "./workflow-schedule"
import { sweepExpired } from "./retention"
import { scanForUpkeep, scheduleUpkeepScan, UPKEEP_KINDS } from "./upkeep"
import { upkeepRepository } from "./upkeep-repository"
import type { JobHandler } from "./worker"
import { meteringOutboxRelay } from "./metering-outbox"
import { REFRESH_CREDIT_STATES_KIND, refreshCreditStates } from "./credit-state"
import { runValkeyAclRevocation, VALKEY_ACL_REVOCATION_KIND } from "@lib/services"
import { meterValkeyQueuesJob, METER_VALKEY_QUEUES_KIND } from "./valkey-metering"
import { meterNeonDatabasesJob, METER_NEON_DATABASES_KIND } from "./neon-metering"
import { reconcileActiveUsageJob, RECONCILE_ACTIVE_USAGE_KIND } from "./active-usage-reconciliation"
import { CUSTOM_DOMAIN_KINDS, reconcileCustomDomain, scanCustomDomains } from "./custom-domain"
import {
  PLATFORM_EDGE_CERTIFICATE_KIND,
  reconcilePlatformEdgeCertificate,
} from "./platform-edge-certificate"
import {
  importStaticCloudFrontLog,
  reconcileStaticCloudFrontUsage,
  scanStaticCloudFrontLogs,
  STATIC_CLOUDFRONT_METERING_KINDS,
} from "./static-cloudfront-metering"
import { ACCOUNT_TEARDOWN_KIND, tearDownAccount } from "./account-teardown"

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
  tearDownAccount: ACCOUNT_TEARDOWN_KIND,
  expireCreditHolds: "billing.expire_holds",
  importUsage: "billing.import_clickhouse_usage",
  relayMeteringOutbox: "billing.relay_metering_outbox",
  reconcileActiveUsage: RECONCILE_ACTIVE_USAGE_KIND,
  chargeUsage: "billing.charge_usage",
  refreshCreditStates: REFRESH_CREDIT_STATES_KIND,
  purgeExpiredAgentEvents: "agent.purge_events",
  purgeDeletedTenants: "platform.purge_deleted",
  reconcileSearchSecurity: "platform.reconcile_search_security",
  reconcileValkeyAcl: "platform.reconcile_valkey_acl",
  sweepExpired: "platform.retention_sweep",
  upkeepScan: UPKEEP_KINDS.scan,
  upkeepRepository: UPKEEP_KINDS.repository,
  publishRelease: PUBLISH_KINDS.release,
  tearDownPreview: PUBLISH_KINDS.tearDownPreview,
  cleanUpStaticPreview: PUBLISH_KINDS.cleanUpStaticPreview,
  refreshRoutes: REFRESH_ROUTES_KIND,
  analyzeRepository: ANALYSIS_KIND,
  provisionProject: PROVISION_KIND,
  workflowRun: WORKFLOW_RUN_KIND,
  workflowScheduleScan: "workflow.schedule_scan",
  tearDownProject: TEARDOWN_KIND,
  provisionSandbox: SANDBOX_KINDS.provision,
  startSandbox: SANDBOX_KINDS.start,
  stopSandbox: SANDBOX_KINDS.stop,
  destroySandbox: SANDBOX_KINDS.destroy,
  reconcileSandboxes: SANDBOX_KINDS.reconcile,
  reapSandboxes: SANDBOX_KINDS.reap,
  meterSandboxes: SANDBOX_KINDS.meter,
  meterValkeyQueues: METER_VALKEY_QUEUES_KIND,
  meterNeonDatabases: METER_NEON_DATABASES_KIND,
  revokeValkeyAclUser: VALKEY_ACL_REVOCATION_KIND,
  customDomainScan: CUSTOM_DOMAIN_KINDS.scan,
  customDomainReconcile: CUSTOM_DOMAIN_KINDS.reconcile,
  reconcilePlatformEdgeCertificate: PLATFORM_EDGE_CERTIFICATE_KIND,
  scanStaticCloudFrontLogs: STATIC_CLOUDFRONT_METERING_KINDS.scan,
  importStaticCloudFrontLog: STATIC_CLOUDFRONT_METERING_KINDS.importObject,
  reconcileStaticCloudFrontUsage: STATIC_CLOUDFRONT_METERING_KINDS.reconcile,
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
 * Make Postgres's billable rollups an absolute projection of deduplicated ClickHouse events.
 *
 * The cutoff comes from ClickHouse before the query. Messages stored afterward therefore compare
 * above this cursor on the next run even if the API and ClickHouse clocks disagree. Cursor and
 * rollups commit together in Postgres, so a retry recomputes the same absolute values.
 */
const importUsageJob: JobHandler = async (_job, { db }) => {
  if (!observabilityConfigured()) {
    throw new Error(
      "CLICKHOUSE_URL is not set; authoritative usage rollups cannot be imported into billing",
    )
  }
  const since = (await importedUsageCursor(db)) ?? new Date(0)
  const until = await clickhouseUsageWatermark()
  const rows = await usageRollupsChangedBetween(since, until)
  await applyImportedUsageRollups(db, rows, until)
  if (rows.length > 0) console.info(`[jobs] imported ${rows.length} ClickHouse usage rollups`)
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

/** Repair live OpenSearch Security identities and make cardinality/drift visible. */
const reconcileSearchSecurityJob: JobHandler = async (_job, { db }) => {
  const rootKey = process.env.SEARCH_PROXY_SECURITY_ROOT_KEY
  if (rootKey === undefined || rootKey === "") {
    throw new Error(
      "SEARCH_PROXY_SECURITY_ROOT_KEY is not set; OpenSearch tenant identities cannot be reconciled",
    )
  }
  const configuredLimit = process.env.SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT
  const softLimit =
    configuredLimit === undefined ? SEARCH_SECURITY_CARDINALITY_SOFT_LIMIT : Number(configuredLimit)
  const report = await reconcileSearchSecurity(db, searchAdminConfigFromEnv(), rootKey, softLimit)
  const fields = [
    `expected=${report.expected}`,
    `observed_users=${report.observed.users}`,
    `observed_roles=${report.observed.roles}`,
    `observed_mappings=${report.observed.mappings}`,
    `missing_users=${report.missing.users}`,
    `missing_roles=${report.missing.roles}`,
    `missing_mappings=${report.missing.mappings}`,
    `drifted_users=${report.drifted.users}`,
    `drifted_roles=${report.drifted.roles}`,
    `drifted_mappings=${report.drifted.mappings}`,
    `repaired_users=${report.repaired.users}`,
    `repaired_roles=${report.repaired.roles}`,
    `repaired_mappings=${report.repaired.mappings}`,
    `orphaned_users=${report.orphaned.users}`,
    `orphaned_roles=${report.orphaned.roles}`,
    `orphaned_mappings=${report.orphaned.mappings}`,
    `list_ms=${report.listLatencyMs.toFixed(1)}`,
    `repair_ms=${report.repairLatencyMs.toFixed(1)}`,
    `soft_limit=${report.softLimit}`,
    `pending_repairs=${report.pendingRepairs}`,
  ].join(" ")
  console.info(`[jobs] OpenSearch Security reconciliation ${fields}`)
  if (
    report.softLimitExceeded ||
    report.orphaned.users > 0 ||
    report.orphaned.roles > 0 ||
    report.orphaned.mappings > 0 ||
    report.pendingRepairs > 0 ||
    report.repaired.users > 0 ||
    report.repaired.roles > 0 ||
    report.repaired.mappings > 0
  ) {
    console.warn(
      `[jobs] OpenSearch Security attention required soft_limit_exceeded=${report.softLimitExceeded} ${fields}`,
    )
  }
}

/** Repair live Valkey engine ACL identities; unknown identities are reported but never deleted. */
const reconcileValkeyAclJob: JobHandler = async (_job, { db }) => {
  const rootKey = process.env.VALKEY_PROXY_ACL_ROOT_KEY
  if (rootKey === undefined || rootKey === "") {
    throw new Error(
      "VALKEY_PROXY_ACL_ROOT_KEY is not set; Valkey tenant ACL users cannot be reconciled",
    )
  }
  const adminUrl = process.env.SERVICE_VALKEY_ADMIN_URL ?? process.env.VALKEY_URL
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error(
      "SERVICE_VALKEY_ADMIN_URL is not set; Valkey tenant ACL users cannot be reconciled",
    )
  }
  const configuredLimit = process.env.VALKEY_ACL_CARDINALITY_SOFT_LIMIT
  const softLimit =
    configuredLimit === undefined ? VALKEY_ACL_CARDINALITY_SOFT_LIMIT : Number(configuredLimit)
  const report = await reconcileValkeyAcl(db, adminUrl, rootKey, { softLimit })
  const fields = [
    `expected=${report.expected}`,
    `observed=${report.observed}`,
    `missing=${report.missing}`,
    `drifted=${report.drifted}`,
    `repaired=${report.repaired}`,
    `orphaned=${report.orphaned}`,
    `inspected=${report.inspected}`,
    `pending_inspections=${report.pendingInspections}`,
    `pending_repairs=${report.pendingRepairs}`,
    `list_ms=${report.listLatencyMs.toFixed(1)}`,
    `repair_ms=${report.repairLatencyMs.toFixed(1)}`,
    `soft_limit=${report.softLimit}`,
  ].join(" ")
  console.info(`[jobs] Valkey ACL reconciliation ${fields}`)
  if (
    report.softLimitExceeded ||
    report.orphaned > 0 ||
    report.pendingInspections > 0 ||
    report.pendingRepairs > 0 ||
    report.repaired > 0
  ) {
    console.warn(
      `[jobs] Valkey ACL attention required soft_limit_exceeded=${report.softLimitExceeded} ${fields}`,
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
 * Separate from the ClickHouse importer because the two fail differently and should be retried
 * differently: importing is absolute arithmetic over durable raw usage, and charging touches
 * balances. An import retried ten times must not post ten charges.
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

const revokeValkeyAclUser: JobHandler = async (job, { db }) => {
  const payload = job.payload as { generationId?: unknown; username?: unknown }
  if (typeof payload.generationId !== "string" || typeof payload.username !== "string") {
    throw new Error("Valkey ACL revocation payload requires generationId and username")
  }
  const adminUrl = process.env.SERVICE_VALKEY_ADMIN_URL
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error("SERVICE_VALKEY_ADMIN_URL is not set; Valkey ACL revocation cannot run")
  }
  await runValkeyAclRevocation(db, adminUrl, {
    generationId: payload.generationId,
    username: payload.username,
  })
}

export const PLATFORM_HANDLERS: Record<string, JobHandler> = {
  /*
    The GitHub webhook handlers.

    Spread rather than listed, because the receiver in `webhooks.ts` decides the kinds and this is
    the other side of that contract — `github-events.ts` owns both the names and the work. Five
    kinds were being queued with no handler at all.
  */
  ...GITHUB_EVENT_HANDLERS,
  [JOB_KINDS.expireCreditHolds]: expireCreditHolds,
  [JOB_KINDS.importUsage]: importUsageJob,
  [JOB_KINDS.relayMeteringOutbox]: meteringOutboxRelay(),
  [JOB_KINDS.reconcileActiveUsage]: reconcileActiveUsageJob(),
  [JOB_KINDS.chargeUsage]: chargeUsageJob,
  [JOB_KINDS.refreshCreditStates]: refreshCreditStates(),
  [JOB_KINDS.purgeExpiredAgentEvents]: purgeExpiredAgentEvents,
  [JOB_KINDS.purgeDeletedTenants]: purgeDeletedTenants,
  [JOB_KINDS.reconcileSearchSecurity]: reconcileSearchSecurityJob,
  [JOB_KINDS.reconcileValkeyAcl]: reconcileValkeyAclJob,
  [JOB_KINDS.sweepExpired]: retentionSweep,
  // The day is baked into the handler so a scan that is retried tomorrow keys tomorrow's jobs.
  [JOB_KINDS.upkeepScan]: (job, context) =>
    scanForUpkeep(new Date().toISOString().slice(0, 10))(job, context),
  [JOB_KINDS.upkeepRepository]: upkeepRepository(),
  [JOB_KINDS.publishRelease]: publishRelease(),
  [JOB_KINDS.tearDownPreview]: tearDownPreview(),
  [JOB_KINDS.cleanUpStaticPreview]: cleanUpStaticPreview(),
  [JOB_KINDS.refreshRoutes]: refreshRoutes(),
  [JOB_KINDS.analyzeRepository]: analyzeRepositoryJob,
  [JOB_KINDS.provisionProject]: provisionProjectJob,
  [JOB_KINDS.tearDownProject]: tearDownProject(),
  [JOB_KINDS.tearDownAccount]: tearDownAccount,
  [JOB_KINDS.workflowRun]: workflowRunJob,
  [JOB_KINDS.workflowScheduleScan]: async (_job, { db }) => {
    const runs = await runDueWorkflowSchedules(db)
    if (runs > 0) console.info(`[jobs] started ${runs} scheduled workflow run(s)`)
  },
  [JOB_KINDS.provisionSandbox]: provisionSandbox(),
  [JOB_KINDS.startSandbox]: startSandbox(),
  [JOB_KINDS.stopSandbox]: stopSandbox(),
  [JOB_KINDS.destroySandbox]: destroySandbox(),
  [JOB_KINDS.reconcileSandboxes]: reconcileSandboxes(),
  [JOB_KINDS.reapSandboxes]: reapSandboxes,
  [JOB_KINDS.meterSandboxes]: meterSandboxes,
  [JOB_KINDS.meterValkeyQueues]: meterValkeyQueuesJob(),
  [JOB_KINDS.meterNeonDatabases]: meterNeonDatabasesJob(),
  [JOB_KINDS.revokeValkeyAclUser]: revokeValkeyAclUser,
  [JOB_KINDS.customDomainScan]: scanCustomDomains(),
  [JOB_KINDS.customDomainReconcile]: reconcileCustomDomain(),
  [JOB_KINDS.reconcilePlatformEdgeCertificate]: reconcilePlatformEdgeCertificate(),
  [JOB_KINDS.scanStaticCloudFrontLogs]: scanStaticCloudFrontLogs(),
  [JOB_KINDS.importStaticCloudFrontLog]: importStaticCloudFrontLog(),
  [JOB_KINDS.reconcileStaticCloudFrontUsage]: reconcileStaticCloudFrontUsage(),
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

  if (process.env.PLATFORM_EDGE_ROLLOUT_ENABLED !== undefined) {
    await enqueue(db, {
      /*
        Every minute. Most runs are a cheap durable-state check. During issuance this converges the
        DNS-01 order; after issuance it keeps the restart handoff visible until live router replicas
        acknowledge the exact immutable S3 version they loaded at boot. The explicit 0/1 rollout
        variable is also the enablement signal, so an ordinary local worker with no platform AWS
        resources does not create a permanently failing singleton job.
      */
      kind: JOB_KINDS.reconcilePlatformEdgeCertificate,
      idempotencyKey: `${JOB_KINDS.reconcilePlatformEdgeCertificate}:${now.toISOString().slice(0, 16)}`,
      maxAttempts: 5,
    })
  }
  await enqueue(db, {
    kind: JOB_KINDS.customDomainScan,
    idempotencyKey: `${JOB_KINDS.customDomainScan}:${now.toISOString().slice(0, 16)}`,
    maxAttempts: 5,
  })
  if (process.env.TENANT_STATIC_DISTRIBUTION_ID !== undefined) {
    await enqueue(db, {
      /*
        Hourly, re-reading the last three closed UTC days. CloudFront standard logs can arrive a
        day late and its provider metrics can also settle after first publication. Absolute daily
        upserts make both corrections converge; unmatched residual remains platform overhead.
      */
      kind: JOB_KINDS.reconcileStaticCloudFrontUsage,
      idempotencyKey: `${JOB_KINDS.reconcileStaticCloudFrontUsage}:${hour}`,
      maxAttempts: 5,
    })
  }
  await enqueue(db, {
    kind: JOB_KINDS.workflowScheduleScan,
    idempotencyKey: `${JOB_KINDS.workflowScheduleScan}:${now.toISOString().slice(0, 16)}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every minute. This is the durable bridge for control-plane usage committed alongside a
      ledger settlement or resource watermark; a minute is the maximum normal Kafka delay.
    */
    kind: JOB_KINDS.relayMeteringOutbox,
    idempotencyKey: `${JOB_KINDS.relayMeteringOutbox}:${now.toISOString().slice(0, 16)}`,
    maxAttempts: 10,
  })
  await enqueue(db, {
    /*
      Every five minutes, with the actual importer fanned out by immutable S3 object. Standard
      logs usually arrive within an hour but may be delayed for a day. A durable consumer cursor
      recovers arbitrarily long worker outages; its two-day overlap lets the background-job
      idempotency key absorb late objects and already-seen objects.
    */
    kind: JOB_KINDS.scanStaticCloudFrontLogs,
    idempotencyKey: `${JOB_KINDS.scanStaticCloudFrontLogs}:${now.toISOString().slice(0, 14)}${String(Math.floor(now.getUTCMinutes() / 5) * 5).padStart(2, "0")}`,
    maxAttempts: 5,
  })
  await enqueue(db, {
    /*
      Hourly, behind Neon's approximately fifteen-minute consumption refresh. The handler uses
      closed provider windows and commits each service watermark with its outbox rows, so retries
      are exact and a missed run is recovered from history rather than estimated.
    */
    kind: JOB_KINDS.meterNeonDatabases,
    idempotencyKey: `${JOB_KINDS.meterNeonDatabases}:${hour}`,
    maxAttempts: 10,
  })
  await enqueue(db, {
    /*
      Hourly. ClickHouse is authoritative; this generation swap repairs eviction and applies
      corrected event versions without replacing increments that arrive during the rebuild.
    */
    kind: JOB_KINDS.reconcileActiveUsage,
    idempotencyKey: `${JOB_KINDS.reconcileActiveUsage}:${hour}`,
    maxAttempts: 5,
  })
  await enqueue(db, {
    /*
      Every five minutes. The sampler emits only an interval bracketed by two successful
      observations; missed windows are deliberately left unbilled rather than extrapolated.
    */
    kind: JOB_KINDS.meterValkeyQueues,
    idempotencyKey: `${JOB_KINDS.meterValkeyQueues}:${now.toISOString().slice(0, 14)}${String(Math.floor(now.getUTCMinutes() / 5) * 5).padStart(2, "0")}`,
    maxAttempts: 10,
  })
  await enqueue(db, {
    kind: JOB_KINDS.expireCreditHolds,
    idempotencyKey: `${JOB_KINDS.expireCreditHolds}:${hour}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Hourly, against a 24-hour TTL.

      Deliberately far inside the window rather than close to it. Route keys are written once at
      deploy and expire in a day; before this job existed nothing rewrote them, so every tenant site
      stopped resolving 24 hours after its last deploy — the router has no fallback and a miss is a
      404. Hourly means twenty-three consecutive failures before a customer notices, which is enough
      slack that a transient Valkey problem is not an outage.
    */
    kind: JOB_KINDS.refreshRoutes,
    idempotencyKey: `${JOB_KINDS.refreshRoutes}:${hour}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every ten minutes, not hourly.

      This imports absolute, deduplicated ClickHouse totals into the Postgres rows the dashboard
      and charge job read. The interval is how stale the visible cost figure is allowed to be.
    */
    kind: JOB_KINDS.importUsage,
    idempotencyKey: `${JOB_KINDS.importUsage}:${tenMinuteWindow(now)}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    /*
      Every ten minutes too, right behind the rollup.

      The two are separate jobs because they fail differently: importing is absolute arithmetic
      over ClickHouse rows, and charging moves balances. An import retried ten times must not post
      ten charges, and keeping them apart is what makes each retry policy sane on its own.

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
      Every five minutes against a fifteen-minute TTL.

      This is a projection, not the ledger: retries simply replace the same key. Three missed
      windows make the key expire and the router fail open, so a cache or worker outage cannot
      become a platform-wide 402.
    */
    kind: JOB_KINDS.refreshCreditStates,
    idempotencyKey: `${JOB_KINDS.refreshCreditStates}:${now.toISOString().slice(0, 14)}${String(Math.floor(now.getUTCMinutes() / 5) * 5).padStart(2, "0")}`,
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
    // Hourly: drifted-open roles are repaired even when no tenant happens to make a request.
    kind: JOB_KINDS.reconcileSearchSecurity,
    idempotencyKey: `${JOB_KINDS.reconcileSearchSecurity}:${hour}`,
    maxAttempts: 5,
  })
  await enqueue(db, {
    // Hourly and bounded: startup repair handles deploy-time drift; this catches later mutation.
    kind: JOB_KINDS.reconcileValkeyAcl,
    idempotencyKey: `${JOB_KINDS.reconcileValkeyAcl}:${hour}`,
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
  await scheduleSandboxJobs(db, now)
}
