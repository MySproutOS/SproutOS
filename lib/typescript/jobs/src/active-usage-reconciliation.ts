/* oxlint-disable no-await-in-loop -- ordered pages and generation transitions are intentional */
import {
  abortActiveUsageRebuild,
  acknowledgeActiveUsagePending,
  activeUsagePending,
  applyActiveUsageToBuildingGeneration,
  beginActiveUsageRebuild,
  cleanupActiveUsageGeneration,
  finalizeActiveUsageRebuild,
  type ActiveUsageEvent,
} from "@lib/metering"
import { activeUsageEventsPage } from "@lib/observability"
import type { DB } from "@sproutos/db"
import { Redis } from "ioredis"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"

export const RECONCILE_ACTIVE_USAGE_KIND = "billing.reconcile_active_usage"
export const ACTIVE_USAGE_PAGE_SIZE = 500
export const DEFAULT_ACTIVE_USAGE_MAX_ORGANIZATIONS = 10_000
export const DEFAULT_ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION = 100_000
export const DEFAULT_ACTIVE_USAGE_MAX_GENERATION_KEYS = 250_000
export const ACTIVE_USAGE_WINDOW_MS = 40 * 24 * 60 * 60 * 1000

export type ActiveUsageReconciliationOptions = {
  pageSize?: number
  maximumEvents?: number
  maximumGenerationKeys?: number
  now?: Date
}

export type ActiveUsagePageSource = (
  organizationId: string,
  since: Date,
  afterEventId: string,
  limit: number,
) => Promise<ActiveUsageEvent[]>

export type ActiveUsageReconciliationReport = {
  organizationId: string
  clickhouseEvents: number
  pendingEvents: number
  removedGenerationKeys: number
}

/**
 * Replace one organization's current cache generation from authoritative ClickHouse rows.
 *
 * `beginActiveUsageRebuild` turns synchronous writers into dual writers before the first query.
 * Their version-aware writes therefore survive an older ClickHouse page and the atomic pointer
 * switch. The bounded pending hash covers Kafka records acknowledged just before the rebuild but
 * not consumed by ClickHouse yet. A blank generation, rather than mutation of the live hashes, is
 * what makes partial cache eviction repairable without overwriting concurrent increments.
 */
export async function reconcileActiveUsageOrganization(
  redis: Redis,
  organizationId: string,
  source: ActiveUsagePageSource = activeUsageEventsPage,
  options: ActiveUsageReconciliationOptions = {},
): Promise<ActiveUsageReconciliationReport> {
  const pageSize = options.pageSize ?? ACTIVE_USAGE_PAGE_SIZE
  const maximumEvents = options.maximumEvents ?? DEFAULT_ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION
  const maximumGenerationKeys =
    options.maximumGenerationKeys ?? DEFAULT_ACTIVE_USAGE_MAX_GENERATION_KEYS
  const since = new Date((options.now ?? new Date()).getTime() - ACTIVE_USAGE_WINDOW_MS)
  requirePositiveInteger(pageSize, "active usage page size", 1000)
  requirePositiveInteger(maximumEvents, "active usage event limit")
  requirePositiveInteger(maximumGenerationKeys, "active usage generation-key limit")

  const rebuild = await beginActiveUsageRebuild(redis, organizationId)
  let finalized = false
  let clickhouseEvents = 0
  let pendingEvents = 0
  let removedGenerationKeys = 0
  const projectedEventIds = new Set<string>()

  try {
    if (rebuild.stale !== null && rebuild.stale !== rebuild.current) {
      removedGenerationKeys += await cleanupActiveUsageGeneration(
        redis,
        organizationId,
        rebuild.stale,
        maximumGenerationKeys,
      )
    }

    let afterEventId = ""
    for (;;) {
      const rows = await source(organizationId, since, afterEventId, pageSize)
      if (rows.length > pageSize) throw new Error("active usage source returned an oversized page")
      clickhouseEvents += rows.length
      if (clickhouseEvents > maximumEvents) {
        throw new Error(
          `active usage cardinality exceeds the configured limit of ${maximumEvents} for ${organizationId}`,
        )
      }
      for (const row of rows) {
        if (row.organizationId !== organizationId) {
          throw new Error(`active usage source crossed organization boundary for ${organizationId}`)
        }
        await applyActiveUsageToBuildingGeneration(redis, rebuild.generation, row)
        await acknowledgeActiveUsagePending(redis, row)
        projectedEventIds.add(row.eventId)
      }
      if (rows.length < pageSize) break
      const last = rows.at(-1)
      if (last === undefined || last.eventId <= afterEventId) {
        throw new Error("active usage source did not advance its event-id cursor")
      }
      afterEventId = last.eventId
    }

    const pending = await activeUsagePending(redis, organizationId, maximumEvents)
    pendingEvents = pending.length
    for (const event of pending) {
      projectedEventIds.add(event.eventId)
      if (projectedEventIds.size > maximumEvents) {
        throw new Error(
          `active usage cardinality exceeds the configured limit of ${maximumEvents} for ${organizationId}`,
        )
      }
      await applyActiveUsageToBuildingGeneration(redis, rebuild.generation, event)
    }

    const previous = await finalizeActiveUsageRebuild(redis, organizationId, rebuild.generation)
    finalized = true
    if (previous !== null && previous !== rebuild.generation) {
      removedGenerationKeys += await cleanupActiveUsageGeneration(
        redis,
        organizationId,
        previous,
        maximumGenerationKeys,
      )
    }
  } catch (error) {
    if (!finalized) {
      await abortActiveUsageRebuild(redis, organizationId, rebuild.generation)
      await cleanupActiveUsageGeneration(
        redis,
        organizationId,
        rebuild.generation,
        maximumGenerationKeys,
      ).catch((cleanupError: unknown) => {
        console.error(
          `[billing] failed to clean abandoned active usage generation ${rebuild.generation} for ${organizationId}`,
          cleanupError,
        )
      })
    }
    throw error
  }

  return { organizationId, clickhouseEvents, pendingEvents, removedGenerationKeys }
}

export type ActiveUsageReconciliationJobDependencies = {
  connect?: () => Redis
  source?: ActiveUsagePageSource
  options?: ActiveUsageReconciliationOptions
}

export function reconcileActiveUsageJob(
  dependencies: ActiveUsageReconciliationJobDependencies = {},
): JobHandler {
  return async (_job, { db }) => {
    const maximumOrganizations = integerFromEnv(
      "ACTIVE_USAGE_MAX_ORGANIZATIONS",
      DEFAULT_ACTIVE_USAGE_MAX_ORGANIZATIONS,
    )
    const organizations = await activeOrganizations(db, maximumOrganizations)
    const redis =
      dependencies.connect?.() ?? new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
    let events = 0
    let pending = 0
    let removed = 0
    try {
      for (const organizationId of organizations) {
        const report = await reconcileActiveUsageOrganization(
          redis,
          organizationId,
          dependencies.source,
          dependencies.options ?? optionsFromEnv(),
        )
        events += report.clickhouseEvents
        pending += report.pendingEvents
        removed += report.removedGenerationKeys
      }
    } finally {
      if (dependencies.connect === undefined) await redis.quit()
    }
    console.info(
      `[billing] reconciled active usage for ${organizations.length} organization(s): ${events} ClickHouse event(s), ${pending} pending event(s), ${removed} stale key(s) removed`,
    )
  }
}

async function activeOrganizations(db: Kysely<DB>, maximum: number): Promise<string[]> {
  const rows = await db
    .selectFrom("organization")
    .select("id")
    .where("deletedAt", "is", null)
    .orderBy("id")
    .limit(maximum + 1)
    .execute()
  if (rows.length > maximum) {
    throw new Error(`active organization cardinality exceeds the configured limit of ${maximum}`)
  }
  return rows.map((row) => row.id)
}

function optionsFromEnv(): ActiveUsageReconciliationOptions {
  return {
    pageSize: integerFromEnv("ACTIVE_USAGE_RECONCILIATION_PAGE_SIZE", ACTIVE_USAGE_PAGE_SIZE, 1000),
    maximumEvents: integerFromEnv(
      "ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION",
      DEFAULT_ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION,
    ),
    maximumGenerationKeys: integerFromEnv(
      "ACTIVE_USAGE_MAX_GENERATION_KEYS",
      DEFAULT_ACTIVE_USAGE_MAX_GENERATION_KEYS,
    ),
  }
}

function integerFromEnv(name: string, fallback: number, maximum?: number): number {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  requirePositiveInteger(parsed, name, maximum)
  return parsed
}

function requirePositiveInteger(value: number, name: string, maximum?: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new RangeError(
      `${name} must be a positive integer${maximum === undefined ? "" : ` no greater than ${maximum}`}`,
    )
  }
}
