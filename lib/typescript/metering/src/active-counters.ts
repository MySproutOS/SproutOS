/* oxlint-disable no-await-in-loop -- Redis cursor scans must advance sequentially */
import { randomUUID } from "node:crypto"
import type { Redis } from "ioredis"

export const ACTIVE_COUNTER_SCALE = 1_000_000_000n
export const ACTIVE_COUNTER_TTL_SECONDS = 40 * 24 * 60 * 60
export const ACTIVE_PROJECTION_PREFIX = "metering:active:v2"
export const DEFAULT_ACTIVE_USAGE_MAX_PENDING_EVENTS = 100_000

export type ActiveUsageEvent = {
  eventId: string
  organizationId: string
  projectId: string | null
  dimension: string
  quantity: number | string
  occurredAt: Date
  /** Decimal UInt64 used by ClickHouse's ReplacingMergeTree. */
  version: string
}

type EncodedContribution = {
  v: string
  p: string
  d: string
  m: string
  n: string
}

const APPLY_GENERATION = String.raw`
local function decimal_compare(left, right)
  left = string.gsub(left, '^0+', '')
  right = string.gsub(right, '^0+', '')
  if left == '' then left = '0' end
  if right == '' then right = '0' end
  if string.len(left) ~= string.len(right) then
    return string.len(left) < string.len(right) and -1 or 1
  end
  if left == right then return 0 end
  return left < right and -1 or 1
end

local function bucket_key(generation, project, day)
  return ARGV[1] .. ':g:' .. generation .. ':' .. project .. ':' .. day
end

local function apply_generation(generation)
  local marker_key = ARGV[1] .. ':g:' .. generation .. ':event:' .. ARGV[2]
  local keys_key = ARGV[1] .. ':g:' .. generation .. ':keys'
  local new_bucket = bucket_key(generation, ARGV[5], ARGV[6])
  local new_epoch = redis.call('HGET', new_bucket, '__epoch')
  if not new_epoch then
    new_epoch = ARGV[10]
    redis.call('HSET', new_bucket, '__epoch', new_epoch)
  end

  local old_json = redis.call('GET', marker_key)
  if old_json then
    local old = cjson.decode(old_json)
    local comparison = decimal_compare(old.v, ARGV[3])
    if comparison > 0 then return 0 end
    if comparison == 0 then
      if old.p ~= ARGV[5] or old.d ~= ARGV[6] or old.m ~= ARGV[7] or old.n ~= ARGV[8] then
        return redis.error_reply('same usage event version has different projection data')
      end
      if old.e == new_epoch then return 0 end
      -- The bucket key was evicted while its event marker survived. Its new epoch proves this
      -- contribution is absent and can be restored without double-counting the other events.
    else
      local old_bucket = bucket_key(generation, old.p, old.d)
      if redis.call('HGET', old_bucket, '__epoch') == old.e then
        local remaining = redis.call('HINCRBY', old_bucket, old.m, '-' .. old.n)
        if remaining == 0 then redis.call('HDEL', old_bucket, old.m) end
      end
    end
  end

  redis.call('HINCRBY', new_bucket, ARGV[7], ARGV[8])
  redis.call('EXPIRE', new_bucket, ARGV[9])
  redis.call('SET', marker_key, cjson.encode({
    v = ARGV[3], p = ARGV[5], d = ARGV[6], m = ARGV[7], n = ARGV[8], e = new_epoch
  }), 'EX', ARGV[9])
  redis.call('SADD', keys_key, marker_key, new_bucket)
  redis.call('EXPIRE', keys_key, ARGV[9])
  return 1
end
`

const APPLY = `${APPLY_GENERATION}
local pending = redis.call('HGET', KEYS[2], ARGV[2])
if not pending and redis.call('HLEN', KEYS[2]) >= tonumber(ARGV[11]) then
  return redis.error_reply('active usage pending cardinality exceeds the configured limit')
end
local current = redis.call('HGET', KEYS[1], 'current')
if not current then
  current = 'bootstrap'
  redis.call('HSET', KEYS[1], 'current', current)
end
local changed = apply_generation(current)
local building = redis.call('HGET', KEYS[1], 'building')
if building and building ~= current then
  changed = changed + apply_generation(building)
end

local pending_json = cjson.encode({
  v = ARGV[3], p = ARGV[5], d = ARGV[6], m = ARGV[7], n = ARGV[8]
})
if not pending or decimal_compare(cjson.decode(pending).v, ARGV[3]) <= 0 then
  redis.call('HSET', KEYS[2], ARGV[2], pending_json)
end
redis.call('EXPIRE', KEYS[1], ARGV[9])
redis.call('EXPIRE', KEYS[2], ARGV[9])
return changed
`

const APPLY_BUILDING = `${APPLY_GENERATION}
if redis.call('HGET', KEYS[1], 'building') ~= ARGV[11] then
  return redis.error_reply('active usage generation is no longer building')
end
return apply_generation(ARGV[11])
`

const BEGIN_REBUILD = `
local current = redis.call('HGET', KEYS[1], 'current')
if not current then current = 'bootstrap' end
local stale = redis.call('HGET', KEYS[1], 'building') or ''
redis.call('HSET', KEYS[1], 'current', current, 'building', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return {current, stale}
`

const FINALIZE_REBUILD = `
if redis.call('HGET', KEYS[1], 'building') ~= ARGV[1] then
  return redis.error_reply('active usage generation is no longer building')
end
local previous = redis.call('HGET', KEYS[1], 'current') or ''
redis.call('HSET', KEYS[1], 'current', ARGV[1])
redis.call('HDEL', KEYS[1], 'building')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return previous
`

const ABORT_REBUILD = `
if redis.call('HGET', KEYS[1], 'building') == ARGV[1] then
  redis.call('HDEL', KEYS[1], 'building')
  return 1
end
return 0
`

const ACK_PENDING = String.raw`
local value = redis.call('HGET', KEYS[1], ARGV[1])
if not value then return 0 end
local pending = cjson.decode(value)
local left = string.gsub(pending.v, '^0+', '')
local right = string.gsub(ARGV[2], '^0+', '')
if left == '' then left = '0' end
if right == '' then right = '0' end
local acknowledged = string.len(left) < string.len(right)
  or (string.len(left) == string.len(right) and left <= right)
if acknowledged then return redis.call('HDEL', KEYS[1], ARGV[1]) end
return 0
`

const READ_ACTIVE = `
local generation = redis.call('HGET', KEYS[1], 'current')
if not generation then return '0' end
local bucket = ARGV[1] .. ':g:' .. generation .. ':' .. ARGV[2] .. ':' .. ARGV[3]
return redis.call('HGET', bucket, ARGV[4]) or '0'
`

/** Convert a non-negative decimal to fixed-point nano-units without `INCRBYFLOAT` drift. */
export function quantityToNanoUnits(quantity: number | string): string {
  const text = typeof quantity === "number" ? quantity.toString() : quantity
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (match === null) throw new RangeError(`Invalid non-negative quantity: ${text}`)

  const whole = match[1]
  const fraction = match[2] ?? ""
  const exponent = Number(match[3] ?? "0")
  if (!Number.isSafeInteger(exponent))
    throw new RangeError(`Quantity exponent is too large: ${text}`)

  const digits = BigInt(`${whole}${fraction}`)
  const power = exponent - fraction.length + 9
  let scaled: bigint
  if (power >= 0) {
    scaled = digits * 10n ** BigInt(power)
  } else {
    const divisor = 10n ** BigInt(-power)
    const quotient = digits / divisor
    const remainder = digits % divisor
    scaled = quotient + (remainder * 2n >= divisor ? 1n : 0n)
  }

  if (scaled > 9_223_372_036_854_775_807n) {
    throw new RangeError(`Quantity exceeds Valkey's signed 64-bit counter: ${text}`)
  }
  return scaled.toString()
}

function organizationBase(organizationId: string): string {
  return `${ACTIVE_PROJECTION_PREFIX}:{${organizationId}}`
}

export function activeUsageControlKey(organizationId: string): string {
  return `${organizationBase(organizationId)}:control`
}

export function activeUsagePendingKey(organizationId: string): string {
  return `${organizationBase(organizationId)}:pending`
}

export function activeUsageBucketKey(event: ActiveUsageEvent, generation = "bootstrap"): string {
  const day = event.occurredAt.toISOString().slice(0, 10).replaceAll("-", "")
  return `${organizationBase(event.organizationId)}:g:${generation}:${event.projectId ?? "_"}:${day}`
}

export function activeUsageGenerationKeysKey(organizationId: string, generation: string): string {
  return `${organizationBase(organizationId)}:g:${generation}:keys`
}

export function activeUsageEventKey(
  organizationId: string,
  generation: string,
  eventId: string,
): string {
  return `${organizationBase(organizationId)}:g:${generation}:event:${eventId}`
}

function contribution(event: ActiveUsageEvent): EncodedContribution {
  if (!/^\d+$/.test(event.version)) throw new Error("active usage version must be a decimal UInt64")
  return {
    v: event.version,
    p: event.projectId ?? "_",
    d: event.occurredAt.toISOString().slice(0, 10).replaceAll("-", ""),
    m: event.dimension,
    n: quantityToNanoUnits(event.quantity),
  }
}

function applyArguments(event: ActiveUsageEvent): string[] {
  const encoded = contribution(event)
  return [
    organizationBase(event.organizationId),
    event.eventId,
    encoded.v,
    event.organizationId,
    encoded.p,
    encoded.d,
    encoded.m,
    encoded.n,
    ACTIVE_COUNTER_TTL_SECONDS.toString(),
    randomUUID(),
  ]
}

/**
 * Apply one Kafka-acknowledged event to the live generation and any generation being rebuilt.
 *
 * Each generation remembers the ClickHouse version and its exact contribution. A newer version
 * subtracts the old contribution before adding the replacement, while an older rebuild row cannot
 * overwrite a concurrent writer. The pending hash closes the Kafka-to-ClickHouse lag window: a
 * rebuild replays entries ClickHouse has not acknowledged yet before switching generations.
 */
export async function applyActiveUsage(
  redis: Pick<Redis, "eval">,
  event: ActiveUsageEvent,
  maximumPendingEvents = activeUsageMaximumPendingEvents(),
): Promise<"applied" | "duplicate"> {
  requirePositiveInteger(maximumPendingEvents, "active usage pending event limit")
  const result = await redis.eval(
    APPLY,
    2,
    activeUsageControlKey(event.organizationId),
    activeUsagePendingKey(event.organizationId),
    ...applyArguments(event),
    maximumPendingEvents.toString(),
  )
  return Number(result) > 0 ? "applied" : "duplicate"
}

export async function beginActiveUsageRebuild(
  redis: Pick<Redis, "eval">,
  organizationId: string,
  generation = randomUUID().replaceAll("-", ""),
): Promise<{ generation: string; current: string; stale: string | null }> {
  const result = (await redis.eval(
    BEGIN_REBUILD,
    1,
    activeUsageControlKey(organizationId),
    generation,
    ACTIVE_COUNTER_TTL_SECONDS.toString(),
  )) as [string, string]
  return { generation, current: result[0], stale: result[1] === "" ? null : result[1] }
}

export async function applyActiveUsageToBuildingGeneration(
  redis: Pick<Redis, "eval">,
  generation: string,
  event: ActiveUsageEvent,
): Promise<"applied" | "duplicate"> {
  const result = await redis.eval(
    APPLY_BUILDING,
    1,
    activeUsageControlKey(event.organizationId),
    ...applyArguments(event),
    generation,
  )
  return Number(result) > 0 ? "applied" : "duplicate"
}

export async function acknowledgeActiveUsagePending(
  redis: Pick<Redis, "eval">,
  event: ActiveUsageEvent,
): Promise<void> {
  await redis.eval(
    ACK_PENDING,
    1,
    activeUsagePendingKey(event.organizationId),
    event.eventId,
    event.version,
  )
}

export async function activeUsagePending(
  redis: Pick<Redis, "hlen" | "hscan">,
  organizationId: string,
  maximum: number,
): Promise<ActiveUsageEvent[]> {
  const key = activeUsagePendingKey(organizationId)
  const cardinality = await redis.hlen(key)
  if (cardinality > maximum) {
    throw new Error(
      `active usage pending cardinality exceeds the configured limit of ${maximum} for ${organizationId}`,
    )
  }
  const pending = new Map<string, ActiveUsageEvent>()
  let cursor = "0"
  do {
    const [next, entries] = await redis.hscan(key, cursor, "COUNT", Math.min(500, maximum + 1))
    cursor = next
    for (let index = 0; index < entries.length; index += 2) {
      const eventId = entries[index]
      const encoded = JSON.parse(entries[index + 1]) as EncodedContribution
      pending.set(eventId, {
        eventId,
        organizationId,
        projectId: encoded.p === "_" ? null : encoded.p,
        dimension: encoded.m,
        quantity: nanoUnitsToQuantity(encoded.n),
        occurredAt: dayTimestamp(encoded.d),
        version: encoded.v,
      })
      if (pending.size > maximum) {
        throw new Error(
          `active usage pending cardinality exceeds the configured limit of ${maximum} for ${organizationId}`,
        )
      }
    }
  } while (cursor !== "0")
  return [...pending.values()]
}

export async function finalizeActiveUsageRebuild(
  redis: Pick<Redis, "eval">,
  organizationId: string,
  generation: string,
): Promise<string | null> {
  const previous = String(
    await redis.eval(
      FINALIZE_REBUILD,
      1,
      activeUsageControlKey(organizationId),
      generation,
      ACTIVE_COUNTER_TTL_SECONDS.toString(),
    ),
  )
  return previous === "" ? null : previous
}

export async function abortActiveUsageRebuild(
  redis: Pick<Redis, "eval">,
  organizationId: string,
  generation: string,
): Promise<void> {
  await redis.eval(ABORT_REBUILD, 1, activeUsageControlKey(organizationId), generation)
}

export async function cleanupActiveUsageGeneration(
  redis: Pick<Redis, "sscan" | "unlink">,
  organizationId: string,
  generation: string,
  maximumKeys: number,
): Promise<number> {
  const keysKey = activeUsageGenerationKeysKey(organizationId, generation)
  let cursor = "0"
  const removed = new Set<string>()
  do {
    const [next, keys] = await redis.sscan(keysKey, cursor, "COUNT", 500)
    cursor = next
    const newKeys = keys.filter((key) => {
      if (removed.has(key)) return false
      removed.add(key)
      return true
    })
    if (removed.size > maximumKeys) {
      throw new Error(
        `active usage generation ${generation} exceeds the cleanup limit of ${maximumKeys} keys`,
      )
    }
    if (newKeys.length > 0) await redis.unlink(...newKeys)
  } while (cursor !== "0")
  await redis.unlink(keysKey)
  return removed.size
}

export async function readActiveUsage(
  redis: Pick<Redis, "eval">,
  event: Pick<ActiveUsageEvent, "organizationId" | "projectId" | "dimension" | "occurredAt">,
): Promise<string> {
  return String(
    await redis.eval(
      READ_ACTIVE,
      1,
      activeUsageControlKey(event.organizationId),
      organizationBase(event.organizationId),
      event.projectId ?? "_",
      event.occurredAt.toISOString().slice(0, 10).replaceAll("-", ""),
      event.dimension,
    ),
  )
}

function nanoUnitsToQuantity(nanoUnits: string): string {
  const padded = nanoUnits.padStart(10, "0")
  const whole = padded.slice(0, -9)
  const fraction = padded.slice(-9).replace(/0+$/, "")
  return fraction === "" ? whole : `${whole}.${fraction}`
}

function dayTimestamp(day: string): Date {
  if (!/^\d{8}$/.test(day)) throw new Error(`invalid active usage day ${JSON.stringify(day)}`)
  return new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00.000Z`)
}

function activeUsageMaximumPendingEvents(): number {
  const configured = process.env.ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION
  if (configured === undefined || configured === "") {
    return DEFAULT_ACTIVE_USAGE_MAX_PENDING_EVENTS
  }
  const parsed = Number(configured)
  requirePositiveInteger(parsed, "ACTIVE_USAGE_MAX_EVENTS_PER_ORGANIZATION")
  return parsed
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}
