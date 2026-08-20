import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"
import type { MicroUsd } from "./money"

export type AccountKind = "user_credit" | "platform_revenue" | "promotional" | "stripe_clearing"

export type TransactionKind =
  | "topup"
  | "usage"
  | "overhead"
  | "refund"
  | "promo"
  | "adjustment"
  | "hold_settle"

/** One posting. Positive increases the account, negative decreases it. */
export type Posting = {
  account: AccountKind
  amount: MicroUsd
}

export type PostTransaction = {
  organizationId: string
  kind: TransactionKind
  /**
   * Makes the whole posting exactly-once. A webhook redelivery, a retried job,
   * or a double-clicked button reuses the key and the second attempt is a no-op
   * rather than a second charge.
   */
  idempotencyKey: string
  postings: Posting[]
  referenceType?: string | null
  referenceId?: string | null
  description?: string | null
}

export class UnbalancedTransactionError extends Error {
  override readonly name = "UnbalancedTransactionError"

  constructor(sum: bigint) {
    super(`Postings must sum to zero; got ${sum.toString()}`)
  }
}

export class InsufficientBalanceError extends Error {
  override readonly name = "InsufficientBalanceError"

  constructor(
    readonly available: MicroUsd,
    readonly required: MicroUsd,
  ) {
    super(
      `Insufficient balance: ${available.toString()} available, ${required.toString()} required`,
    )
  }
}

/**
 * Post a balanced transaction.
 *
 * Every movement of money is a set of postings that sum to zero. The database
 * enforces that too, with a deferred constraint trigger, so a caller that gets
 * the arithmetic wrong fails at commit rather than silently creating money — but
 * checking here as well turns that into a typed error at the call site instead
 * of an opaque constraint violation.
 *
 * Returns the existing transaction id when the idempotency key has been seen.
 */
export async function post(
  db: Kysely<DB>,
  input: PostTransaction,
): Promise<{ transactionId: string; created: boolean }> {
  const sum = input.postings.reduce((total, p) => total + p.amount, 0n)
  if (sum !== 0n) throw new UnbalancedTransactionError(sum)
  if (input.postings.length === 0) throw new UnbalancedTransactionError(0n)

  return await db.transaction().execute(async (tx) => postWithin(tx, input))
}

/** Post inside a transaction the caller already owns — holds settle this way. */
export async function postWithin(
  tx: Transaction<DB>,
  input: PostTransaction,
): Promise<{ transactionId: string; created: boolean }> {
  const existing = await tx
    .selectFrom("creditTransaction")
    .select("id")
    .where("idempotencyKey", "=", input.idempotencyKey)
    .executeTakeFirst()

  if (existing) return { transactionId: existing.id, created: false }

  const transactionId = v7()
  await tx
    .insertInto("creditTransaction")
    .values({
      id: transactionId,
      organizationId: input.organizationId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      description: input.description ?? null,
    })
    .execute()

  const accounts = await ensureAccounts(
    tx,
    input.organizationId,
    input.postings.map((p) => p.account),
  )

  await tx
    .insertInto("creditLedgerEntry")
    .values(
      input.postings.map((p) => ({
        id: v7(),
        creditTransactionId: transactionId,
        creditAccountId: accounts[p.account]!,
        amountMicroUsd: p.amount,
      })),
    )
    .execute()

  return { transactionId, created: true }
}

/**
 * Spend against a balance, refusing to overdraw.
 *
 * The balance read and the posting happen in one transaction with the account
 * row locked, because two concurrent spends that each read the same balance
 * would both pass a check done outside a lock and together overdraw it.
 */
export async function spend(
  db: Kysely<DB>,
  input: PostTransaction & { debitFrom?: AccountKind },
): Promise<{ transactionId: string; created: boolean }> {
  const from = input.debitFrom ?? "user_credit"
  const required = input.postings
    .filter((p) => p.account === from && p.amount < 0n)
    .reduce((total, p) => total - p.amount, 0n)

  return await db.transaction().execute(async (tx) => {
    const accountId = (await ensureAccounts(tx, input.organizationId, [from]))[from]!
    await tx
      .selectFrom("creditAccount")
      .select("id")
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst()

    const available = await availableBalance(tx, input.organizationId, from)
    if (available < required) throw new InsufficientBalanceError(available, required)

    return await postWithin(tx, input)
  })
}

/**
 * The balance an organization may actually spend: posted entries minus active holds.
 *
 * Reads the compaction checkpoint and adds the uncompacted tail. The checkpoint
 * is `compacted_at`, set once per entry and never by a sequence — an identity
 * sequence allocates its number at INSERT and not at COMMIT, so a transaction
 * that takes a number and commits after a later one is skipped permanently once
 * the compactor advances past it, and under-counting spend loses money.
 */
export async function availableBalance(
  db: Kysely<DB> | Transaction<DB>,
  organizationId: string,
  kind: AccountKind = "user_credit",
): Promise<MicroUsd> {
  return await balances(db, organizationId, kind).then((b) => b.available)
}

/**
 * The two balances, read together.
 *
 * `posted` is what the ledger says the account holds; `available` is what may actually be spent,
 * which is `posted` minus every active hold. They differ exactly when a run is in flight, and a UI
 * that shows one without the other cannot explain why a top-up did not raise the spendable figure.
 */
export async function balances(
  db: Kysely<DB> | Transaction<DB>,
  organizationId: string,
  kind: AccountKind = "user_credit",
): Promise<{ posted: MicroUsd; held: MicroUsd; available: MicroUsd }> {
  const account = await db
    .selectFrom("creditAccount")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("kind", "=", kind)
    .executeTakeFirst()

  if (!account) return { posted: 0n, held: 0n, available: 0n }

  const cached = await db
    .selectFrom("creditBalanceCache")
    .select("balanceMicroUsd")
    .where("creditAccountId", "=", account.id)
    .executeTakeFirst()

  const tail = await db
    .selectFrom("creditLedgerEntry")
    .select((eb) => eb.fn.sum<string>("amountMicroUsd").as("total"))
    .where("creditAccountId", "=", account.id)
    .where("compactedAt", "is", null)
    .executeTakeFirst()

  const held = await db
    .selectFrom("creditHold")
    .select((eb) => eb.fn.sum<string>("amountMicroUsd").as("total"))
    .where("creditAccountId", "=", account.id)
    .where("status", "=", "active")
    .executeTakeFirst()

  const posted = BigInt(cached?.balanceMicroUsd ?? 0n) + BigInt(tail?.total ?? "0")
  const reserved = BigInt(held?.total ?? "0")
  return { posted, held: reserved, available: posted - reserved }
}

async function ensureAccounts(
  tx: Transaction<DB>,
  organizationId: string,
  kinds: AccountKind[],
): Promise<Partial<Record<AccountKind, string>>> {
  const wanted = [...new Set(kinds)]

  await tx
    .insertInto("creditAccount")
    .values(
      wanted.map((kind) => ({
        id: v7(),
        organizationId,
        kind,
        currency: "USD",
      })),
    )
    .onConflict((oc) => oc.columns(["organizationId", "kind"]).doNothing())
    .execute()

  const rows = await tx
    .selectFrom("creditAccount")
    .select(["id", "kind"])
    .where("organizationId", "=", organizationId)
    .where("kind", "in", wanted)
    .execute()

  return Object.fromEntries(rows.map((r) => [r.kind, r.id]))
}
