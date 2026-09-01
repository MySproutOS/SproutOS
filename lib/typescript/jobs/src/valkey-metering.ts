/* oxlint-disable no-await-in-loop -- serialize shared-engine scans and per-service commits */
import { crudMeteringOutbox } from "@lib/dao"
import { encodeUsageEvent, usageEventRecord } from "@lib/metering"
import { valkeyKeyPrefix } from "@lib/services"
import type { DB, JsonValue } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import type { JobHandler } from "./worker"

export const METER_VALKEY_QUEUES_KIND = "billing.meter_valkey_queues"
export const VALKEY_METERING_BATCH_SIZE = 100
export const VALKEY_METERING_INTERVAL_MS = 5 * 60 * 1000
export const VALKEY_METERING_MAX_GAP_MS = VALKEY_METERING_INTERVAL_MS + 60 * 1000

const SCAN_COUNT = 500

export type ValkeyMemorySample = {
  backendServiceId: string
  memoryBytes: bigint
  observedAt: Date
}

export type ValkeyMeteringOptions = {
  observedAt?: Date
  backendServiceIds?: string[]
  redis?: Redis
  /** Deletion-only settlement: sample even inside the normal cadence and close a stale tail. */
  final?: boolean
}

/** Sum only keys in the engine-enforced namespace, including full nested-value memory. */
export async function sampleTenantValkeyMemory(
  redis: Redis,
  backendServiceId: string,
): Promise<bigint> {
  // This dimension is queue residency, not every byte in the customer's general-purpose Valkey
  // service. BullMQ adds this exact prefix to each workflow queue key; a cache key in the same
  // tenant namespace must never become workflow usage merely because both share an engine.
  const prefix = `${valkeyKeyPrefix(backendServiceId)}:`
  let cursor = "0"
  let total = 0n

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", SCAN_COUNT)
    cursor = next
    for (const key of keys) {
      if (!key.startsWith(prefix)) {
        throw new Error(`Valkey SCAN returned a key outside ${JSON.stringify(prefix)}`)
      }
      // `SAMPLES 0` examines every nested element. The default samples only five and is an
      // estimate for large hashes, lists, sets and sorted sets, which is not suitable for billing.
      const measured = await redis.call("MEMORY", "USAGE", key, "SAMPLES", 0)
      // A key may expire or be deleted after SCAN names it. It owned no memory when measured.
      if (measured === null) continue
      if (typeof measured !== "number" || !Number.isSafeInteger(measured) || measured < 0) {
        throw new Error(`Valkey returned an invalid MEMORY USAGE value for ${JSON.stringify(key)}`)
      }
      total += BigInt(measured)
    }
  } while (cursor !== "0")

  return total
}

/** Exact decimal spelling of trapezoidal byte-seconds from millisecond observations. */
export function sampledByteSeconds(
  previousBytes: bigint,
  currentBytes: bigint,
  elapsedMs: number,
): string {
  if (previousBytes < 0n || currentBytes < 0n)
    throw new RangeError("memory bytes cannot be negative")
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs <= 0) {
    throw new RangeError("elapsedMs must be a positive safe integer")
  }

  const numerator = (previousBytes + currentBytes) * BigInt(elapsedMs)
  const denominator = 2_000n
  const whole = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return whole.toString()
  const fraction = ((remainder * 10_000n) / denominator).toString().padStart(4, "0")
  return `${whole}.${fraction.replace(/0+$/, "")}`
}

type Candidate = {
  backendServiceId: string
  organizationId: string
  projectId: string | null
}

export async function meterValkeyQueues(
  db: Kysely<DB>,
  adminUrl: string,
  options: ValkeyMeteringOptions = {},
): Promise<number> {
  const observedAt = options.observedAt ?? new Date()
  const dueBefore = new Date(observedAt.getTime() - VALKEY_METERING_INTERVAL_MS)
  let candidateQuery = db
    .selectFrom("backendService")
    .leftJoin("valkeyMeteringState", "valkeyMeteringState.backendServiceId", "backendService.id")
    .select([
      "backendService.id as backendServiceId",
      "backendService.organizationId",
      "backendService.projectId",
    ])
    .where("backendService.kind", "=", "valkey")
    .where("backendService.deletedAt", "is", null)
    .$if(options.final !== true, (query) =>
      query.where((eb) =>
        eb.or([
          eb("valkeyMeteringState.sampledAt", "is", null),
          eb("valkeyMeteringState.sampledAt", "<=", dueBefore),
        ]),
      ),
    )

  if (options.backendServiceIds !== undefined) {
    if (options.backendServiceIds.length === 0) return 0
    candidateQuery = candidateQuery.where("backendService.id", "in", options.backendServiceIds)
  }

  const candidates = (await candidateQuery
    .orderBy(sql`valkey_metering_state.sampled_at asc nulls first`)
    .orderBy("backendService.id", "asc")
    .limit(VALKEY_METERING_BATCH_SIZE)
    .execute()) as Candidate[]

  if (candidates.length === 0) return 0

  const redis = options.redis ?? new Redis(adminUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  const ownsRedis = options.redis === undefined
  if (ownsRedis) {
    redis.on("error", () => {})
    await redis.connect()
  }

  let emitted = 0
  try {
    for (const candidate of candidates) {
      const sample: ValkeyMemorySample = {
        backendServiceId: candidate.backendServiceId,
        memoryBytes: await sampleTenantValkeyMemory(redis, candidate.backendServiceId),
        observedAt,
      }
      emitted += await persistSample(db, candidate, sample, options.final === true)
    }
  } finally {
    if (ownsRedis) redis.disconnect()
  }
  return emitted
}

async function persistSample(
  db: Kysely<DB>,
  candidate: Candidate,
  sample: ValkeyMemorySample,
  final: boolean,
): Promise<number> {
  return await db.transaction().execute(async (trx) => {
    const previous = await trx
      .selectFrom("valkeyMeteringState")
      .select(["sampledAt", "memoryBytes"])
      .where("backendServiceId", "=", candidate.backendServiceId)
      .forUpdate()
      .executeTakeFirst()

    if (previous !== undefined && sample.observedAt <= previous.sampledAt) return 0

    let emitted = 0
    if (previous !== undefined) {
      const elapsedMs = sample.observedAt.getTime() - previous.sampledAt.getTime()
      // A missing observation is lost usage, not permission to extrapolate an arbitrarily long
      // interval. Reset the baseline and resume with the next successfully bracketed sample.
      if (final || elapsedMs <= VALKEY_METERING_MAX_GAP_MS) {
        const quantity = sampledByteSeconds(
          BigInt(previous.memoryBytes),
          sample.memoryBytes,
          elapsedMs,
        )
        if (quantity !== "0") {
          const event = usageEventRecord({
            source: "valkey-control-plane",
            externalId: `${candidate.backendServiceId}:valkey_queue_byte_second:${previous.sampledAt.toISOString()}`,
            organizationId: candidate.organizationId,
            projectId: candidate.projectId,
            resourceType: "valkey_queue",
            resourceId: candidate.backendServiceId,
            dimension: "valkey_queue_byte_second",
            quantity,
            occurredAt: sample.observedAt,
            windowStart: previous.sampledAt,
            windowEnd: sample.observedAt,
            nodeId: null,
            podUid: null,
            chargedExternally: false,
            attributes: {
              current_memory_bytes: sample.memoryBytes.toString(),
              previous_memory_bytes: previous.memoryBytes,
              sampling_method: "trapezoidal",
            },
          })
          await crudMeteringOutbox(trx).create({
            id: v7(),
            eventId: event.eventId,
            payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
          })
          emitted = 1
        }
      }
    }

    await trx
      .insertInto("valkeyMeteringState")
      .values({
        backendServiceId: candidate.backendServiceId,
        memoryBytes: sample.memoryBytes.toString(),
        sampledAt: sample.observedAt,
      })
      .onConflict((oc) =>
        oc.column("backendServiceId").doUpdateSet({
          memoryBytes: sample.memoryBytes.toString(),
          sampledAt: sample.observedAt,
          updatedAt: new Date(),
        }),
      )
      .execute()
    return emitted
  })
}

export function meterValkeyQueuesJob(): JobHandler {
  return async (_job, { db }) => {
    const adminUrl = process.env.SERVICE_VALKEY_ADMIN_URL
    if (adminUrl === undefined || adminUrl === "") {
      throw new Error("SERVICE_VALKEY_ADMIN_URL is not set; Valkey queue memory cannot be metered")
    }
    const emitted = await meterValkeyQueues(db, adminUrl)
    if (emitted > 0) console.info(`[jobs] metered ${emitted} Valkey queue interval(s)`)
  }
}
