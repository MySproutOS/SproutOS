/* oxlint-disable no-await-in-loop -- provider batches and per-branch transactions are bounded */
import { crudMeteringOutbox } from "@lib/dao"
import { encodeUsageEvent, usageEventRecord } from "@lib/metering"
import {
  neonApi,
  neonApiConfigFromEnv,
  type NeonBranchConsumption,
  type NeonConfig,
} from "@lib/services"
import type { DB, JsonValue } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import type { JobHandler } from "./worker"

export const METER_NEON_DATABASES_KIND = "billing.meter_neon_databases"
export const NEON_CONSUMPTION_BATCH_SIZE = 100
export const NEON_CONSUMPTION_MAX_BATCHES = 10
export const NEON_CONSUMPTION_LAG_MS = 30 * 60 * 1000
export const NEON_CONSUMPTION_LOOKBACK_MS = 167 * 60 * 60 * 1000

const GB = 1_000_000_000n
const QUANTITY_SCALE = 1_000_000_000n

type NeonConsumptionClient = {
  branchConsumption: (input: {
    projectIds: string[]
    branchIds?: string[]
    from: Date
    to: Date
  }) => Promise<NeonBranchConsumption[]>
}

type Candidate = {
  backendServiceId: string
  databaseBranchId: string
  organizationId: string
  projectId: string | null
  providerProjectId: string
  providerBranchId: string
  kind: string
  createdAt: Date
  deletedAt: Date | null
  meteredThrough: Date | null
}

type AggregatedTimeframe = {
  start: Date
  end: Date
  periodIds: Set<string>
  metrics: Map<string, bigint>
}

export type NeonMeteringOptions = {
  now?: Date
  client?: NeonConsumptionClient
  backendServiceIds?: string[]
  maxBatches?: number
}

/** Last provider hour old enough that Neon's approximately 15-minute refresh has settled. */
export function neonConsumptionCutoff(now: Date): Date {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new RangeError("now must be a valid date")
  return new Date(Math.floor((timestamp - NEON_CONSUMPTION_LAG_MS) / 3_600_000) * 3_600_000)
}

/** Convert Neon's exact byte-month integer into its invoice-aligned decimal GB-month unit. */
export function neonByteMonthsToGbMonths(byteMonths: bigint): string {
  if (byteMonths < 0n) throw new RangeError("Neon byte-months cannot be negative")
  const scaled = (byteMonths * QUANTITY_SCALE) / GB
  const whole = scaled / QUANTITY_SCALE
  const fraction = (scaled % QUANTITY_SCALE).toString().padStart(9, "0").replace(/0+$/, "")
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`
}

function providerInteger(value: number, metric: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Neon returned an invalid ${metric} value: ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

function date(value: string, field: string): Date {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Neon returned an invalid ${field}: ${JSON.stringify(value)}`)
  }
  return parsed
}

function aggregateBranch(
  branch: NeonBranchConsumption | undefined,
  from: Date,
  to: Date,
): AggregatedTimeframe[] {
  if (branch === undefined) return []
  const byWindow = new Map<string, AggregatedTimeframe>()

  for (const period of branch.periods) {
    for (const timeframe of period.consumption) {
      const start = date(timeframe.timeframe_start, "timeframe_start")
      const end = date(timeframe.timeframe_end, "timeframe_end")
      if (start >= end || start < from || end > to) {
        throw new Error(
          `Neon returned consumption outside the requested closed range: ${start.toISOString()}..${end.toISOString()}`,
        )
      }

      const key = `${start.toISOString()}/${end.toISOString()}`
      const aggregated = byWindow.get(key) ?? {
        start,
        end,
        periodIds: new Set<string>(),
        metrics: new Map<string, bigint>(),
      }
      aggregated.periodIds.add(period.period_id)
      for (const metric of timeframe.metrics) {
        const value = providerInteger(metric.value, metric.metric_name)
        aggregated.metrics.set(
          metric.metric_name,
          (aggregated.metrics.get(metric.metric_name) ?? 0n) + value,
        )
      }
      byWindow.set(key, aggregated)
    }
  }

  return [...byWindow.values()].toSorted(
    (left, right) => left.start.getTime() - right.start.getTime(),
  )
}

function initialFrom(candidate: Candidate, to: Date): Date {
  const createdHour = Math.floor(candidate.createdAt.getTime() / 3_600_000) * 3_600_000
  return new Date(Math.max(createdHour, to.getTime() - NEON_CONSUMPTION_LOOKBACK_MS))
}

function requestFrom(candidate: Candidate, to: Date): Date {
  const earliest = new Date(to.getTime() - NEON_CONSUMPTION_LOOKBACK_MS)
  if (candidate.meteredThrough !== null && candidate.meteredThrough < earliest) {
    throw new Error(
      `Neon consumption watermark for branch ${candidate.databaseBranchId} is older than hourly history`,
    )
  }
  return candidate.meteredThrough ?? initialFrom(candidate, to)
}

async function candidates(
  db: Kysely<DB>,
  to: Date,
  backendServiceIds?: string[],
): Promise<Candidate[]> {
  let query = db
    .selectFrom("databaseBranch")
    .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
    .innerJoin("backendService", "backendService.id", "databaseInstance.backendServiceId")
    .leftJoin(
      "neonBranchMeteringState",
      "neonBranchMeteringState.databaseBranchId",
      "databaseBranch.id",
    )
    .select([
      "backendService.id as backendServiceId",
      "databaseBranch.id as databaseBranchId",
      "backendService.organizationId",
      "backendService.projectId",
      "databaseInstance.providerProjectId",
      "databaseBranch.providerBranchId",
      "databaseBranch.kind",
      "databaseBranch.createdAt",
      "databaseBranch.deletedAt",
      "neonBranchMeteringState.meteredThrough",
    ])
    .where("databaseInstance.provider", "=", "neon")
    .where("databaseInstance.deletedAt", "is", null)
    .where("backendService.deletedAt", "is", null)
    .where("databaseInstance.providerProjectId", "is not", null)
    .where("databaseBranch.providerBranchId", "is not", null)
    .where((eb) =>
      eb.or([
        eb("neonBranchMeteringState.meteredThrough", "is", null),
        eb("neonBranchMeteringState.meteredThrough", "<", to),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb("databaseBranch.deletedAt", "is", null),
        eb("neonBranchMeteringState.meteredThrough", "is", null),
        eb(
          "neonBranchMeteringState.meteredThrough",
          "<",
          sql<Date>`date_trunc('hour', database_branch.deleted_at) + interval '1 hour'`,
        ),
      ]),
    )

  if (backendServiceIds !== undefined) {
    if (backendServiceIds.length === 0) return []
    query = query.where("backendService.id", "in", backendServiceIds)
  }

  return (await query
    .orderBy(sql`neon_branch_metering_state.metered_through asc nulls first`)
    .orderBy("databaseBranch.id")
    .limit(NEON_CONSUMPTION_BATCH_SIZE)
    .execute()) as Candidate[]
}

async function persistBranch(
  db: Kysely<DB>,
  candidate: Candidate,
  branch: NeonBranchConsumption | undefined,
  requestedFrom: Date,
  to: Date,
): Promise<number> {
  return await db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom("databaseBranch")
      .select("id")
      .where("id", "=", candidate.databaseBranchId)
      .forUpdate()
      .executeTakeFirst()
    if (locked === undefined) return 0

    const state = await trx
      .selectFrom("neonBranchMeteringState")
      .select("meteredThrough")
      .where("databaseBranchId", "=", candidate.databaseBranchId)
      .executeTakeFirst()
    const from = state?.meteredThrough ?? initialFrom(candidate, to)
    const branchTo =
      candidate.deletedAt === null
        ? to
        : new Date(
            Math.min(
              to.getTime(),
              (Math.floor(candidate.deletedAt.getTime() / 3_600_000) + 1) * 3_600_000,
            ),
          )
    if (from >= branchTo) return 0

    const timeframes = aggregateBranch(branch, requestedFrom, to).filter(
      (timeframe) => timeframe.start >= from && timeframe.end <= branchTo,
    )
    const outbox = crudMeteringOutbox(trx)
    let emitted = 0

    for (const timeframe of timeframes) {
      const common = {
        source: "neon-branch-consumption",
        organizationId: candidate.organizationId,
        projectId: candidate.projectId,
        resourceType: "database_branch",
        resourceId: candidate.databaseBranchId,
        occurredAt: timeframe.end,
        windowStart: timeframe.start,
        windowEnd: timeframe.end,
        nodeId: null,
        podUid: null,
        chargedExternally: false,
      } as const
      const providerPeriods = [...timeframe.periodIds].toSorted().join(",")
      const attributes = {
        provider: "neon",
        provider_project_id: candidate.providerProjectId,
        provider_branch_id: candidate.providerBranchId,
        branch_kind: candidate.kind,
        provider_period_ids: providerPeriods,
      }
      const compute = timeframe.metrics.get("compute_unit_seconds") ?? 0n
      if (compute > 0n) {
        const event = usageEventRecord({
          ...common,
          externalId: `${candidate.databaseBranchId}:db_compute_cu_second:${timeframe.start.toISOString()}`,
          dimension: "db_compute_cu_second",
          quantity: compute.toString(),
          attributes: { ...attributes, compute_unit_seconds: compute.toString() },
        })
        await outbox.create({
          id: v7(),
          eventId: event.eventId,
          payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
        })
        emitted++
      }

      const root = timeframe.metrics.get("root_branch_bytes_month") ?? 0n
      const child = timeframe.metrics.get("child_branch_bytes_month") ?? 0n
      if (root + child > 0n) {
        const event = usageEventRecord({
          ...common,
          externalId: `${candidate.databaseBranchId}:db_storage_gb_month:${timeframe.start.toISOString()}`,
          dimension: "db_storage_gb_month",
          quantity: neonByteMonthsToGbMonths(root + child),
          attributes: {
            ...attributes,
            root_branch_bytes_month: root.toString(),
            child_branch_bytes_month: child.toString(),
            conversion: "byte_month/1000000000",
          },
        })
        await outbox.create({
          id: v7(),
          eventId: event.eventId,
          payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
        })
        emitted++
      }

      const history = timeframe.metrics.get("instant_restore_bytes_month") ?? 0n
      if (history > 0n) {
        const event = usageEventRecord({
          ...common,
          externalId: `${candidate.databaseBranchId}:db_history_storage_gb_month:${timeframe.start.toISOString()}`,
          dimension: "db_history_storage_gb_month",
          quantity: neonByteMonthsToGbMonths(history),
          attributes: {
            ...attributes,
            instant_restore_bytes_month: history.toString(),
            conversion: "byte_month/1000000000",
          },
        })
        await outbox.create({
          id: v7(),
          eventId: event.eventId,
          payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
        })
        emitted++
      }
    }

    await trx
      .insertInto("neonBranchMeteringState")
      .values({ databaseBranchId: candidate.databaseBranchId, meteredThrough: branchTo })
      .onConflict((oc) =>
        oc
          .column("databaseBranchId")
          .doUpdateSet({ meteredThrough: branchTo, updatedAt: new Date() }),
      )
      .execute()
    return emitted
  })
}

export async function meterNeonDatabases(
  db: Kysely<DB>,
  config: NeonConfig,
  options: NeonMeteringOptions = {},
): Promise<number> {
  const to = neonConsumptionCutoff(options.now ?? new Date())
  const client = options.client ?? neonApi(config)
  const maxBatches = options.maxBatches ?? NEON_CONSUMPTION_MAX_BATCHES
  let emitted = 0

  for (let batch = 0; batch < maxBatches; batch++) {
    const due = await candidates(db, to, options.backendServiceIds)
    if (due.length === 0) break
    const from = new Date(Math.min(...due.map((candidate) => requestFrom(candidate, to).getTime())))
    if (from >= to) break

    const response = await client.branchConsumption({
      projectIds: [...new Set(due.map((candidate) => candidate.providerProjectId))],
      branchIds: due.map((candidate) => candidate.providerBranchId),
      from,
      to,
    })
    const requested = new Map(
      due.map((candidate) => [candidate.providerBranchId, candidate.providerProjectId]),
    )
    const byBranch = new Map<string, NeonBranchConsumption>()
    for (const branch of response) {
      if (requested.get(branch.branch_id) !== branch.project_id) {
        throw new Error(`Neon returned unrequested branch ${JSON.stringify(branch.branch_id)}`)
      }
      const existing = byBranch.get(branch.branch_id)
      byBranch.set(branch.branch_id, {
        project_id: branch.project_id,
        branch_id: branch.branch_id,
        periods: [...(existing?.periods ?? []), ...branch.periods],
      })
    }

    for (const candidate of due) {
      emitted += await persistBranch(
        db,
        candidate,
        byBranch.get(candidate.providerBranchId),
        from,
        to,
      )
    }
    if (due.length < NEON_CONSUMPTION_BATCH_SIZE) break
  }

  return emitted
}

export function meterNeonDatabasesJob(): JobHandler {
  return async (_job, { db }) => {
    const emitted = await meterNeonDatabases(db, neonApiConfigFromEnv())
    if (emitted > 0) console.info(`[jobs] metered ${emitted} Neon database branch interval(s)`)
  }
}
