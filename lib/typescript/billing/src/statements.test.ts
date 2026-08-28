import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { post } from "./ledger"
import { acquirePlatformJobLock, releasePlatformJobLock } from "./test-lock"
import { addQuantities, generateMonthlyStatements, paidQuantity } from "./statements"

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
  await acquirePlatformJobLock()
  ownerUserId = v7()
  organizationId = v7()
  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `statements-${ownerUserId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      ownerUserId,
      name: "Statement Test",
      slug: `statement-${organizationId.slice(-12)}`,
      kind: "personal",
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("statement").where("organizationId", "=", organizationId).execute()
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
  await releasePlatformJobLock()
})

describe("statement quantity arithmetic", () => {
  it("never converts billing numerics through floating point", () => {
    expect(addQuantities("9007199254740993.123456789", "0.000000001")).toBe(
      "9007199254740993.12345679",
    )
    expect(paidQuantity("100.000000000", 25n, 100n)).toBe("25")
  })
})

describe("monthly statement generation", () => {
  it("imports an exact legacy debit, finalizes it, and is idempotent", async ({ skip }) => {
    if (!reachable) skip()
    await post(db, {
      organizationId,
      kind: "topup",
      idempotencyKey: `statement-credit:${organizationId}`,
      postings: [
        { account: "user_credit", amount: 1_000n },
        { account: "stripe_clearing", amount: -1_000n },
      ],
    })
    const usage = await post(db, {
      organizationId,
      kind: "usage",
      idempotencyKey: `statement-usage:${organizationId}`,
      description: "Legacy metered usage",
      postings: [
        { account: "user_credit", amount: -100n },
        { account: "platform_revenue", amount: 90n },
        { account: "platform_revenue", amount: 10n },
      ],
    })

    const transaction = await db
      .selectFrom("creditTransaction")
      .select("createdAt")
      .where("id", "=", usage.transactionId)
      .executeTakeFirstOrThrow()
    const close = new Date(
      Date.UTC(transaction.createdAt.getUTCFullYear(), transaction.createdAt.getUTCMonth() + 1, 2),
    )
    const first = await generateMonthlyStatements(db, close, { organizationIds: [organizationId] })
    expect(first.importedTransactions).toBe(1)
    expect(first.finalizedStatements).toBe(1)

    const statement = await db
      .selectFrom("statement")
      .select(["id", "status", "subtotalMicroUsd", "overheadMicroUsd", "totalMicroUsd"])
      .where("organizationId", "=", organizationId)
      .where("periodStart", "<=", transaction.createdAt)
      .where("periodEnd", ">", transaction.createdAt)
      .executeTakeFirstOrThrow()
    expect(statement).toMatchObject({
      status: "finalized",
      subtotalMicroUsd: "90",
      overheadMicroUsd: "10",
      totalMicroUsd: "100",
    })
    const lines = await db
      .selectFrom("statementLineItem")
      .select(["kind", "amountMicroUsd"])
      .where("statementId", "=", statement.id)
      .orderBy("kind")
      .execute()
    expect(lines).toEqual([
      { kind: "overhead", amountMicroUsd: "10" },
      { kind: "usage", amountMicroUsd: "90" },
    ])

    const second = await generateMonthlyStatements(db, close, {
      organizationIds: [organizationId],
    })
    expect(second).toEqual({
      importedTransactions: 0,
      createdStatements: 0,
      finalizedStatements: 0,
    })
    expect(
      await db
        .selectFrom("statementCharge")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("creditTransactionId", "=", usage.transactionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "1" })
  })
})
