import type { DB, JsonValue } from "@sproutos/db"
import { InsufficientBalanceError, placeHold, settleHoldWithin } from "@lib/billing"
import { crudMeteringOutbox } from "@lib/dao"
import { encodeUsageEvent, usageEventRecord, type BillableDimension } from "@lib/metering"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"
import { estimateRunCost, rateTokens, type TokenUsage } from "./pricing"
import { type ResolvedAgentCredential, resolveAgentCredential } from "./resolve"

export class AgentNotConfiguredError extends Error {
  override readonly name = "AgentNotConfiguredError"

  constructor(readonly reason: string) {
    super(`No usable agent credential: ${reason}`)
  }
}

/**
 * How many tokens a run is allowed to be worth before it must stop and re-reserve.
 *
 * Not a model limit — a *reservation* size. It bounds how much of our money a single run can spend
 * between two balance checks.
 */
const DEFAULT_RESERVATION_TOKENS = 1_000_000

/** Holds outlive the request that took them, so the TTL is the reaper's deadline, not a timeout. */
const HOLD_TTL_SECONDS = 60 * 60

export type MeteredRunContext = {
  credential: ResolvedAgentCredential
  /**
   * Report tokens as they are consumed. Called per model request rather than once at the end, so a
   * long run cannot accumulate an unbilled tail behind a crash.
   */
  report: (usage: TokenUsage) => void
}

export type MeteredRunResult<T> = {
  value: T
  usage: TokenUsage
  chargedMicroUsd: bigint
}

export type MeteredRun = {
  organizationId: string
  projectId?: string | null
  /** What the hold is against — "agent_run", "repo_analysis", "fork_upkeep". */
  resourceType: string
  resourceId?: string | null
  /** Sizes the reservation. Defaults to a million tokens' worth. */
  reservationTokens?: number
  description?: string | null
}

/**
 * Run something that spends tokens, and make sure somebody pays for it.
 *
 * For a customer's own credential this is a passthrough — their provider bills them directly and
 * we have no claim to press. For platform credits it is the whole safety story:
 *
 *  1. Reserve first. The tokens are bought from the provider as the run proceeds, so checking the
 *     balance afterwards discovers an overdraft it is already too late to prevent.
 *  2. Meter per request, not per run, so a crash mid-run still leaves a settleable total.
 *  3. Settle what actually happened. Anything unused returns to the balance immediately.
 *  4. Release on failure. A run that threw before spending anything must not leave a customer's
 *     balance reserved until the reaper notices.
 *
 * The estimate being wrong is survivable in both directions and deliberately biased high: too
 * small aborts work the customer could afford, too large only makes the remainder briefly
 * unavailable.
 */
export async function withMeteredRun<T>(
  db: Kysely<DB>,
  input: MeteredRun,
  body: (context: MeteredRunContext) => Promise<T>,
): Promise<MeteredRunResult<T>> {
  const credential = await resolveAgentCredential(db, input.organizationId, input.projectId ?? null)
  if (credential.billing === "none") throw new AgentNotConfiguredError(credential.reason)

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  const runId = v7()
  const startedAt = new Date()
  const report = (delta: TokenUsage) => {
    accumulateTokenUsage(usage, delta)
  }

  if (credential.billing === "byo") {
    // Their key, their bill. We still count the tokens, because the usage is worth showing even
    // when there is nothing to charge for it.
    let value: T
    try {
      value = await body({ credential, report })
    } catch (error) {
      // A provider error can arrive after it has consumed and billed tokens. Persist everything
      // reported before the failure just as the platform-credit path does.
      await db.transaction().execute(async (tx) => {
        await recordRunUsage(tx, input, usage, runId, startedAt, true)
      })
      throw error
    }
    await db.transaction().execute(async (tx) => {
      await recordRunUsage(tx, input, usage, runId, startedAt, true)
    })
    return { value, usage, chargedMicroUsd: 0n }
  }

  const reservationTokens = input.reservationTokens ?? DEFAULT_RESERVATION_TOKENS
  const estimate = await estimateRunCost(db, reservationTokens)

  // A budget ceiling caps the reservation, so a project configured for small runs cannot have its
  // whole balance tied up by one of them.
  const amount =
    credential.maxBudgetMicroUsd !== null && credential.maxBudgetMicroUsd < estimate
      ? credential.maxBudgetMicroUsd
      : estimate

  const { holdId } = await placeHold(db, {
    organizationId: input.organizationId,
    amount,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    ttlSeconds: HOLD_TTL_SECONDS,
  })

  let value: T
  try {
    value = await body({ credential, report })
  } catch (error) {
    // Settle whatever was already spent before the failure. A zero-token failure releases the
    // hold while still preserving any measurable run time.
    await settleFrom(db, holdId, usage, input, runId, startedAt)
    throw error
  }

  const charged = await settleFrom(db, holdId, usage, input, runId, startedAt)
  return { value, usage, chargedMicroUsd: charged }
}

/** Add a provider usage report without dropping any independently priced token bucket. */
export function accumulateTokenUsage(usage: TokenUsage, delta: TokenUsage): void {
  usage.inputTokens += delta.inputTokens
  usage.outputTokens += delta.outputTokens
  usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0)
  usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0)
  usage.longContextInputTokens =
    (usage.longContextInputTokens ?? 0) + (delta.longContextInputTokens ?? 0)
  usage.longContextOutputTokens =
    (usage.longContextOutputTokens ?? 0) + (delta.longContextOutputTokens ?? 0)
  usage.longContextCacheReadTokens =
    (usage.longContextCacheReadTokens ?? 0) + (delta.longContextCacheReadTokens ?? 0)
  usage.longContextCacheWriteTokens =
    (usage.longContextCacheWriteTokens ?? 0) + (delta.longContextCacheWriteTokens ?? 0)
}

async function settleFrom(
  db: Kysely<DB>,
  holdId: string,
  usage: TokenUsage,
  input: MeteredRun,
  runId: string,
  startedAt: Date,
): Promise<bigint> {
  const rated = await rateTokens(db, usage)

  return await db.transaction().execute(async (tx) => {
    const settlement = await settleHoldWithin(tx, {
      holdId,
      actual: rated.usage,
      overheadAmount: rated.overhead,
      // Deterministic in the hold, so a retried settlement posts once. The hold itself already
      // refuses a second close, but the ledger key means a retry that races the close is a no-op
      // rather than a duplicate charge.
      idempotencyKey: `hold:${holdId}`,
      description: input.description ?? null,
    })
    await recordRunUsage(tx, input, usage, runId, startedAt, true)
    return settlement.chargedMicroUsd
  })
}

/**
 * Commit the run's usage to the transactional Kafka outbox.
 *
 * For platform credit, the caller runs this in the same transaction as the hold settlement. A
 * charge can therefore never exist without publishable statement detail. BYO tokens are marked
 * externally charged (the provider bills the customer); run time remains a platform dimension.
 */
async function recordRunUsage(
  db: Kysely<DB> | Transaction<DB>,
  input: MeteredRun,
  usage: TokenUsage,
  runId: string,
  startedAt: Date,
  tokensChargedExternally: boolean,
): Promise<void> {
  const occurredAt = new Date()
  const events = runUsageEvents(input, usage, runId, startedAt, occurredAt, tokensChargedExternally)

  for (const event of events) {
    await crudMeteringOutbox(db).create({
      id: v7(),
      eventId: event.eventId,
      payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
    })
  }
}

/** Pure construction boundary so every dimension and its charging semantics are regression tested. */
export function runUsageEvents(
  input: MeteredRun,
  usage: TokenUsage,
  runId: string,
  startedAt: Date,
  occurredAt: Date,
  tokensChargedExternally: boolean,
) {
  const rows: {
    dimension: BillableDimension
    quantity: number
    chargedExternally: boolean
  }[] = [
    {
      dimension: "ai_input_token",
      quantity: usage.inputTokens,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_output_token",
      quantity: usage.outputTokens,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_cache_read_token",
      quantity: usage.cacheReadTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_cache_write_token",
      quantity: usage.cacheWriteTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_long_context_input_token",
      quantity: usage.longContextInputTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_long_context_output_token",
      quantity: usage.longContextOutputTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_long_context_cache_read_token",
      quantity: usage.longContextCacheReadTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "ai_long_context_cache_write_token",
      quantity: usage.longContextCacheWriteTokens ?? 0,
      chargedExternally: tokensChargedExternally,
    },
    {
      dimension: "agent_run_second",
      quantity: (occurredAt.getTime() - startedAt.getTime()) / 1000,
      chargedExternally: false,
    },
  ]

  return rows
    .filter((row) => row.quantity > 0)
    .map((row) =>
      usageEventRecord({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        dimension: row.dimension,
        quantity: String(row.quantity),
        occurredAt,
        windowStart: startedAt,
        windowEnd: occurredAt,
        nodeId: null,
        podUid: null,
        source: "agent",
        externalId: `${runId}:${row.dimension}`,
        chargedExternally: row.chargedExternally,
        attributes: {},
      }),
    )
}

export { InsufficientBalanceError }
