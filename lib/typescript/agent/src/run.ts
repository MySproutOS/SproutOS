import type { DB } from "@sproutos/db"
import { InsufficientBalanceError, placeHold, releaseHold, settleHold } from "@lib/billing"
import type { Kysely } from "kysely"
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
  const report = (delta: TokenUsage) => {
    usage.inputTokens += delta.inputTokens
    usage.outputTokens += delta.outputTokens
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0)
  }

  if (credential.billing === "byo") {
    // Their key, their bill. We still count the tokens, because the usage is worth showing even
    // when there is nothing to charge for it.
    const value = await body({ credential, report })
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
    // Settle whatever was already spent before the failure; release outright if nothing was.
    // Discarding real token spend because the run threw would mean paying for it ourselves.
    const spent = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0)
    if (spent === 0) await releaseHold(db, holdId)
    else await settleFrom(db, holdId, usage, input)
    throw error
  }

  const charged = await settleFrom(db, holdId, usage, input)
  return { value, usage, chargedMicroUsd: charged }
}

async function settleFrom(
  db: Kysely<DB>,
  holdId: string,
  usage: TokenUsage,
  input: MeteredRun,
): Promise<bigint> {
  const rated = await rateTokens(db, usage)

  await settleHold(db, {
    holdId,
    actual: rated.usage,
    overheadAmount: rated.overhead,
    // Deterministic in the hold, so a retried settlement posts once. The hold itself already
    // refuses a second close, but the ledger key means a retry that races the close is a no-op
    // rather than a duplicate charge.
    idempotencyKey: `hold:${holdId}`,
    description: input.description ?? null,
  })

  await recordTokenUsage(db, input, usage, holdId)
  return rated.total
}

/**
 * Write the run's tokens to `usage_event`.
 *
 * Separate from the ledger posting on purpose. The ledger says what was charged; `usage_event`
 * says what was consumed, per dimension, and is what a statement itemizes. A charge with no
 * matching events is a bill nobody can explain.
 */
async function recordTokenUsage(
  db: Kysely<DB>,
  input: MeteredRun,
  usage: TokenUsage,
  holdId: string,
): Promise<void> {
  const occurredAt = new Date()
  const rows = [
    { dimension: "ai_input_token", quantity: usage.inputTokens },
    { dimension: "ai_output_token", quantity: usage.outputTokens },
    { dimension: "ai_cache_read_token", quantity: usage.cacheReadTokens ?? 0 },
  ]
    .filter((row) => row.quantity > 0)
    .map((row) => ({
      id: v7(),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      dimension: row.dimension,
      quantity: String(row.quantity),
      occurredAt,
      source: "agent",
      // The hold is the run's identity here, which makes the whole write idempotent: a retried
      // settlement collides on (source, external_id, occurred_at) rather than double-counting.
      externalId: `${holdId}:${row.dimension}`,
      ratedAt: occurredAt,
    }))

  if (rows.length === 0) return

  await db
    .insertInto("usageEvent")
    .values(rows)
    .onConflict((oc) => oc.columns(["source", "externalId", "occurredAt"]).doNothing())
    .execute()
}

export { InsufficientBalanceError }
