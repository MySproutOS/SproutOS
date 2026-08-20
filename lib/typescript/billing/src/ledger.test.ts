import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import {
  availableBalance,
  InsufficientBalanceError,
  post,
  spend,
  UnbalancedTransactionError,
} from "./ledger"

/**
 * Runs against the docker-compose Postgres. The database is where the real
 * invariants live — the balanced-transaction constraint trigger and the
 * append-only guard are not reimplemented in TypeScript, so testing against a
 * fake would test nothing that matters.
 */
let reachable = false
let organizationId: string
let ownerUserId: string

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `ledger-${ownerUserId}@test.invalid`, name: "Ledger Test" })
    .execute()

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Ledger Test Org",
      slug: `ledger-test-${organizationId.slice(0, 8)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return

  // The ledger is append-only, so ordinary DELETEs are refused by design. This is
  // the same privileged purge path retention and GDPR deletion use: suppress
  // triggers for the duration of one transaction. That it is needed here is the
  // point — cleanup is not supposed to be easy.
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("creditLedgerEntry")
      .where((eb) =>
        eb(
          "creditAccountId",
          "in",
          eb.selectFrom("creditAccount").select("id").where("organizationId", "=", organizationId),
        ),
      )
      .execute()
    await tx.deleteFrom("creditTransaction").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("creditAccount").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })

  await db.destroy()
})

const key = () => `test:${v7()}`

describe("post", () => {
  it("rejects postings that do not sum to zero", async ({ skip }) => {
    if (!reachable) skip()
    await expect(
      post(db, {
        organizationId,
        kind: "adjustment",
        idempotencyKey: key(),
        postings: [{ account: "user_credit", amount: 1_000_000n }],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError)
  })

  it("rejects an empty transaction", async ({ skip }) => {
    if (!reachable) skip()
    await expect(
      post(db, { organizationId, kind: "adjustment", idempotencyKey: key(), postings: [] }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError)
  })

  it("credits a balanced top-up", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const result = await post(db, {
      organizationId,
      kind: "topup",
      idempotencyKey: key(),
      postings: [
        { account: "stripe_clearing", amount: -10_000_000n },
        { account: "user_credit", amount: 9_410_000n },
        { account: "platform_revenue", amount: 590_000n },
      ],
    })

    expect(result.created).toBe(true)
    expect(await availableBalance(db, organizationId)).toBe(before + 9_410_000n)
  })

  it("posts once for a repeated idempotency key", async ({ skip }) => {
    if (!reachable) skip()
    const idempotencyKey = key()
    const postings = [
      { account: "stripe_clearing" as const, amount: -1_000_000n },
      { account: "user_credit" as const, amount: 1_000_000n },
    ]

    const before = await availableBalance(db, organizationId)
    const first = await post(db, { organizationId, kind: "topup", idempotencyKey, postings })
    const second = await post(db, { organizationId, kind: "topup", idempotencyKey, postings })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.transactionId).toBe(first.transactionId)
    // A redelivered webhook must not credit twice.
    expect(await availableBalance(db, organizationId)).toBe(before + 1_000_000n)
  })
})

describe("the database's own invariants", () => {
  it("refuses an unbalanced transaction even when the caller bypasses the check", async ({
    skip,
  }) => {
    if (!reachable) skip()
    // Straight to the tables, skipping post(). The deferred constraint trigger
    // is the real guarantee; the TypeScript check is only a better error message.
    await expect(
      db.transaction().execute(async (tx) => {
        const transactionId = v7()
        await tx
          .insertInto("creditTransaction")
          .values({ id: transactionId, organizationId, kind: "adjustment", idempotencyKey: key() })
          .execute()
        const account = await tx
          .selectFrom("creditAccount")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("kind", "=", "user_credit")
          .executeTakeFirstOrThrow()
        await tx
          .insertInto("creditLedgerEntry")
          .values({
            id: v7(),
            creditTransactionId: transactionId,
            creditAccountId: account.id,
            amountMicroUsd: 999_000_000n,
          })
          .execute()
      }),
    ).rejects.toThrow(/sum to .* expected 0/)
  })

  it("refuses to mutate a posted entry", async ({ skip }) => {
    if (!reachable) skip()
    const entry = await db
      .selectFrom("creditLedgerEntry")
      .innerJoin("creditAccount", "creditAccount.id", "creditLedgerEntry.creditAccountId")
      .select("creditLedgerEntry.id")
      .where("creditAccount.organizationId", "=", organizationId)
      .executeTakeFirstOrThrow()

    await expect(
      db
        .updateTable("creditLedgerEntry")
        .set({ amountMicroUsd: 1n })
        .where("id", "=", entry.id)
        .execute(),
    ).rejects.toThrow(/immutable/)
  })

  it("refuses to delete a posted entry", async ({ skip }) => {
    if (!reachable) skip()
    const entry = await db
      .selectFrom("creditLedgerEntry")
      .innerJoin("creditAccount", "creditAccount.id", "creditLedgerEntry.creditAccountId")
      .select("creditLedgerEntry.id")
      .where("creditAccount.organizationId", "=", organizationId)
      .executeTakeFirstOrThrow()

    await expect(
      db.deleteFrom("creditLedgerEntry").where("id", "=", entry.id).execute(),
    ).rejects.toThrow(/append-only/)
  })
})

describe("spend", () => {
  it("refuses to overdraw", async ({ skip }) => {
    if (!reachable) skip()
    const available = await availableBalance(db, organizationId)

    await expect(
      spend(db, {
        organizationId,
        kind: "usage",
        idempotencyKey: key(),
        postings: [
          { account: "user_credit", amount: -(available + 1_000_000n) },
          { account: "platform_revenue", amount: available + 1_000_000n },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)

    expect(await availableBalance(db, organizationId)).toBe(available)
  })

  it("debits usage and the overhead that rides on it", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)
    const usage = 100_000n
    const overheadAmount = 12_000n

    await spend(db, {
      organizationId,
      kind: "usage",
      idempotencyKey: key(),
      description: "Metered usage",
      postings: [
        { account: "user_credit", amount: -(usage + overheadAmount) },
        { account: "platform_revenue", amount: usage + overheadAmount },
      ],
    })

    expect(await availableBalance(db, organizationId)).toBe(before - usage - overheadAmount)
  })
})
