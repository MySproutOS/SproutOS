import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"
import {
  availableBalance,
  InsufficientBalanceError,
  lockAvailableBalance,
  postWithin,
} from "./ledger"
import type { MicroUsd } from "./money"

/**
 * Reservations against a balance, for work whose cost is only known when it finishes.
 *
 * A metered agent run is the case this exists for. The tokens are bought from the model provider
 * as the run proceeds, so by the time the total is known the money is already spent on our side.
 * Checking the balance afterwards discovers an overdraft it is too late to prevent; checking it
 * beforehand without reserving lets two concurrent runs both pass the same check.
 *
 * So a hold is taken first, `availableBalance` subtracts active holds, and the run settles against
 * it. Every hold ends in exactly one of three states: settled (the work happened and cost
 * something), released (it did not), or expired (nobody said).
 */

export class HoldNotActiveError extends Error {
  override readonly name = "HoldNotActiveError"

  constructor(
    readonly holdId: string,
    readonly status: string,
  ) {
    super(`Hold ${holdId} is ${status}, not active`)
  }
}

export type PlaceHold = {
  organizationId: string
  amount: MicroUsd
  /** What the hold is for — "agent_run", "repo_analysis", "workflow_run". */
  resourceType: string
  resourceId?: string | null
  /**
   * How long the reservation survives without being settled or released. A crashed runner must
   * not strand a customer's balance forever, so there is no unbounded default.
   */
  ttlSeconds: number
}

/**
 * Reserve an amount, refusing to reserve more than is available.
 *
 * Same lock discipline as `spend`: the account row is locked before the balance is read, because
 * two concurrent holds that each read the same balance outside a lock would both pass and together
 * reserve more than exists.
 */
export async function placeHold(
  db: Kysely<DB>,
  input: PlaceHold,
): Promise<{ holdId: string; expiresAt: Date }> {
  if (input.amount <= 0n) {
    throw new RangeError("A hold must reserve a positive amount")
  }

  return await db.transaction().execute(async (tx) => {
    const account = await tx
      .selectFrom("creditAccount")
      .select("id")
      .where("organizationId", "=", input.organizationId)
      .where("kind", "=", "user_credit")
      .forUpdate()
      .executeTakeFirst()

    // No account means no top-up has ever settled, so the balance is zero and the hold cannot be
    // covered. Creating the account here would be a write on a read-shaped failure.
    if (account === undefined) throw new InsufficientBalanceError(0n, input.amount)

    const available = await availableBalance(tx, input.organizationId)
    if (available < input.amount) throw new InsufficientBalanceError(available, input.amount)

    const holdId = v7()
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000)

    await tx
      .insertInto("creditHold")
      .values({
        id: holdId,
        organizationId: input.organizationId,
        creditAccountId: account.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        amountMicroUsd: input.amount,
        status: "active",
        expiresAt,
      })
      .execute()

    return { holdId, expiresAt }
  })
}

export type SettleHold = {
  holdId: string
  /**
   * What the work actually cost. May exceed the hold: the reservation is a guard against starting
   * work that obviously cannot be paid for, not a hard ceiling on a provider's final bill. The
   * customer is still prepaid, so settlement takes only the credit that remains and the platform
   * absorbs any overrun rather than creating debt for a later top-up.
   */
  actual: MicroUsd
  /** Platform overhead on this usage, posted as its own entry so a statement stays explicable. */
  overheadAmount?: MicroUsd
  idempotencyKey: string
  description?: string | null
}

/**
 * Close a hold by charging what the work really cost.
 *
 * The hold is released and the spend is posted in one transaction, so a balance is never briefly
 * double-counted — reserved and charged at the same instant.
 */
export async function settleHold(
  db: Kysely<DB>,
  input: SettleHold,
): Promise<{ transactionId: string; created: boolean; chargedMicroUsd: MicroUsd }> {
  return await db.transaction().execute(async (tx) => await settleHoldWithin(tx, input))
}

/**
 * Settle inside a transaction that also commits the durable metering outbox row.
 *
 * A caller using this form must own the transaction. Keeping it beside `settleHold` avoids copying
 * the ledger operation into the agent package while allowing "charged" and "publishable usage"
 * to remain one atomic fact.
 */
export async function settleHoldWithin(
  tx: Transaction<DB>,
  input: SettleHold,
): Promise<{ transactionId: string; created: boolean; chargedMicroUsd: MicroUsd }> {
  const hold = await lockActiveHold(tx, input.holdId)

  const usage = input.actual
  const platformOverhead = input.overheadAmount ?? 0n
  const total = usage + platformOverhead

  // A run that cost nothing still closes its hold. Posting an all-zero transaction would be a
  // row that says nothing, so the hold is simply released.
  if (total === 0n) {
    await closeHold(tx, hold.id, "released", null)
    return { transactionId: "", created: false, chargedMicroUsd: 0n }
  }

  /*
    Release this hold in the arithmetic, but preserve every other active reservation.

    `lockAvailableBalance` serializes this settlement with every other debit to the account.
    While the hold is still active, `available` has already subtracted its reservation, so adding
    only this hold's amount is the exact balance settlement may consume. Capping here makes
    prepaid a hard floor even when the provider reports more usage than the estimate reserved.
  */
  const available = await lockAvailableBalance(tx, hold.organizationId)
  const spendable = available + BigInt(hold.amountMicroUsd)
  const debit = spendable <= 0n ? 0n : total < spendable ? total : spendable

  if (debit === 0n) {
    await closeHold(tx, hold.id, "settled", null)
    return { transactionId: "", created: false, chargedMicroUsd: 0n }
  }

  // Usage is paid before platform overhead. A capped settlement never takes a fee while forgiving
  // the provider resource cost underneath it.
  const paidUsage = usage < debit ? usage : debit
  const paidOverhead = debit - paidUsage

  const posted = await postWithin(tx, {
    organizationId: hold.organizationId,
    kind: "hold_settle",
    idempotencyKey: input.idempotencyKey,
    referenceType: hold.resourceType,
    referenceId: hold.resourceId,
    description: input.description ?? null,
    postings: [
      { account: "user_credit", amount: -debit },
      { account: "platform_revenue", amount: paidUsage },
      { account: "platform_revenue", amount: paidOverhead },
    ],
  })

  await closeHold(tx, hold.id, "settled", posted.transactionId)
  return { ...posted, chargedMicroUsd: posted.created ? debit : 0n }
}

/** Close a hold without charging: the work did not happen, or failed before it cost anything. */
export async function releaseHold(db: Kysely<DB>, holdId: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const hold = await lockActiveHold(tx, holdId)
    await closeHold(tx, hold.id, "released", null)
  })
}

/**
 * Expire holds nobody closed, freeing the balance they reserved.
 *
 * Run from the job runner. Deliberately does not charge: a hold whose runner vanished has no known
 * cost, and inventing one would bill for work we cannot describe. The loss, if the work did happen,
 * is ours — which is the right incentive for keeping runners honest about settling.
 */
export async function expireHolds(db: Kysely<DB>, limit = 500): Promise<number> {
  const expired = await db
    .updateTable("creditHold")
    .set({ status: "expired", updatedAt: new Date() })
    .where("status", "=", "active")
    .where("expiresAt", "<", new Date())
    .where((eb) =>
      eb(
        "id",
        "in",
        eb
          .selectFrom("creditHold as stale")
          .select("stale.id")
          .where("stale.status", "=", "active")
          .where("stale.expiresAt", "<", new Date())
          .limit(limit),
      ),
    )
    .executeTakeFirst()

  return Number(expired.numUpdatedRows)
}

async function lockActiveHold(tx: Transaction<DB>, holdId: string) {
  const hold = await tx
    .selectFrom("creditHold")
    .select(["id", "organizationId", "resourceType", "resourceId", "status", "amountMicroUsd"])
    .where("id", "=", holdId)
    .forUpdate()
    .executeTakeFirst()

  if (hold === undefined) throw new HoldNotActiveError(holdId, "missing")
  // Settling twice would charge twice. The row is locked, so the second caller sees "settled".
  if (hold.status !== "active") throw new HoldNotActiveError(holdId, hold.status)
  return hold
}

async function closeHold(
  tx: Transaction<DB>,
  holdId: string,
  status: "settled" | "released",
  settledTransactionId: string | null,
): Promise<void> {
  await tx
    .updateTable("creditHold")
    .set({ status, settledTransactionId, updatedAt: new Date() })
    .where("id", "=", holdId)
    .execute()
}
