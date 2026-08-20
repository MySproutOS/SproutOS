import type { DB } from "@sproutos/db"
import { type MicroUsd, overhead, rateTimesQuantity } from "@lib/billing/money"
import type { Kysely, Transaction } from "kysely"

/** The token dimensions in `price_book_item`. Cache writes rate as input tokens. */
export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export type RatedUsage = {
  /** What the tokens cost, before overhead. */
  usage: MicroUsd
  /** The platform's amortized overhead on that usage, as its own number. */
  overhead: MicroUsd
  /** What the organization is actually charged. */
  total: MicroUsd
  priceBookId: string
}

export class NoActivePriceBookError extends Error {
  override readonly name = "NoActivePriceBookError"

  constructor() {
    super(
      "No active price_book. Rating would silently produce zero-cost usage — run the seeds first.",
    )
  }
}

const DIMENSIONS = {
  inputTokens: "ai_input_token",
  outputTokens: "ai_output_token",
  cacheReadTokens: "ai_cache_read_token",
} as const

/**
 * The price book in force, plus its rates for the token dimensions.
 *
 * Deliberately throws when there is none. A missing price book rates every dimension at zero, and
 * zero-cost usage is indistinguishable from free usage on a statement — the most expensive kind of
 * silent failure this system can have.
 */
export async function activeTokenRates(
  db: Kysely<DB> | Transaction<DB>,
  at: Date = new Date(),
): Promise<{ priceBookId: string; overheadBps: number; rates: Record<string, string> }> {
  const book = await db
    .selectFrom("priceBook")
    .select(["id", "overheadBps"])
    .where("effectiveAt", "<=", at)
    // Price books supersede rather than retire: the newest one already in force wins, and an
    // older statement re-rates against whichever book was in force when its usage occurred.
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()

  if (book === undefined) throw new NoActivePriceBookError()

  const items = await db
    .selectFrom("priceBookItem")
    .select(["dimension", "unitMicroUsd"])
    .where("priceBookId", "=", book.id)
    .where("dimension", "in", Object.values(DIMENSIONS))
    .execute()

  const rates: Record<string, string> = {}
  for (const item of items) rates[item.dimension] = String(item.unitMicroUsd)

  return { priceBookId: book.id, overheadBps: book.overheadBps, rates }
}

/**
 * Turn a token count into money.
 *
 * Rates are decimal strings, not integers, because a cache-read token costs 0.33 micro-USD and an
 * integer rate would floor to zero — the dimension would bill nothing, forever. `rateTimesQuantity`
 * multiplies in bigint and rounds the product up.
 */
export async function rateTokens(
  db: Kysely<DB> | Transaction<DB>,
  usage: TokenUsage,
  at: Date = new Date(),
): Promise<RatedUsage> {
  const { priceBookId, overheadBps, rates } = await activeTokenRates(db, at)

  let subtotal = 0n
  for (const [field, dimension] of Object.entries(DIMENSIONS)) {
    const quantity = usage[field as keyof TokenUsage] ?? 0
    if (quantity <= 0) continue

    const rate = rates[dimension]
    // A dimension the price book does not carry is a seeding bug, not a free dimension.
    if (rate === undefined) throw new NoActivePriceBookError()

    subtotal += rateTimesQuantity(rate, String(quantity))
  }

  const platformOverhead = overhead(subtotal, overheadBps)
  return {
    usage: subtotal,
    overhead: platformOverhead,
    total: subtotal + platformOverhead,
    priceBookId,
  }
}

/**
 * What to reserve before a run whose cost is not yet known.
 *
 * A hold has to be taken *before* the first token is bought, so it is a guess. This one is
 * deliberately generous — a hold that is too small aborts work the customer could have afforded,
 * while a hold that is too large only makes the rest of the balance briefly unavailable and is
 * returned in full at settlement.
 */
export async function estimateRunCost(
  db: Kysely<DB> | Transaction<DB>,
  maxTokens: number,
  at: Date = new Date(),
): Promise<MicroUsd> {
  // Priced entirely as output tokens: they are the most expensive dimension, so the estimate is
  // an upper bound on any mix of input, output, and cache reads totalling maxTokens.
  const { total } = await rateTokens(db, { inputTokens: 0, outputTokens: maxTokens }, at)
  return total
}
