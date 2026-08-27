import type { Redis } from "ioredis"

export const ACTIVE_COUNTER_SCALE = 1_000_000_000n
export const ACTIVE_COUNTER_TTL_SECONDS = 40 * 24 * 60 * 60

export type ActiveUsageEvent = {
  eventId: string
  organizationId: string
  projectId: string | null
  dimension: string
  quantity: number | string
  occurredAt: Date
}

const APPLY = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
return 1
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

export function activeUsageKeys(event: ActiveUsageEvent): [seen: string, bucket: string] {
  const tag = `{${event.organizationId}}`
  const day = event.occurredAt.toISOString().slice(0, 10).replaceAll("-", "")
  const project = event.projectId ?? "_"
  return [
    `metering:active:v1:${tag}:seen:${event.eventId}`,
    `metering:active:v1:${tag}:${project}:${day}`,
  ]
}

/**
 * Apply one Kafka-acknowledged event to the live projection.
 *
 * The event-id marker and `HINCRBY` share one Lua invocation and one Valkey cluster hash slot. A
 * replay therefore returns `duplicate` instead of changing the counter twice. ClickHouse remains
 * authoritative. Callers currently make an immediate projection failure retryable because no
 * ClickHouse-to-Valkey rebuild exists; eviction after acknowledgement is not repaired. This is a
 * cache writer, not evidence that prompt feedback or enforcement reads a complete view.
 */
export async function applyActiveUsage(
  redis: Pick<Redis, "eval">,
  event: ActiveUsageEvent,
): Promise<"applied" | "duplicate"> {
  const [seen, bucket] = activeUsageKeys(event)
  const result = await redis.eval(
    APPLY,
    2,
    seen,
    bucket,
    event.dimension,
    quantityToNanoUnits(event.quantity),
    ACTIVE_COUNTER_TTL_SECONDS.toString(),
  )
  return Number(result) === 1 ? "applied" : "duplicate"
}

export function activeUsageBucketKey(event: ActiveUsageEvent): string {
  return activeUsageKeys(event)[1]
}
