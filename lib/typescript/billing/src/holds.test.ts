import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { expireHolds, HoldNotActiveError, placeHold, releaseHold, settleHold } from "./holds"
import { availableBalance, InsufficientBalanceError, post } from "./ledger"

/*
  The *tail* of a UUIDv7, not the head.

  A v7 is 48 bits of millisecond timestamp followed by random bits, so `slice(0, 8)` is pure clock:
  two ids minted in the same millisecond share it exactly. That is not hypothetical — it made this
  suite fail roughly one run in three with
  `duplicate key value violates unique constraint "organization_slug_live_key"`, from a value chosen
  precisely because it was supposed to be unique.

  The last twelve characters are the random half.
*/

/**
 * Against the docker-compose Postgres, like ledger.test.ts, and for the same reason: the row lock
 * that makes concurrent holds safe is a database behaviour, not a TypeScript one.
 */
let reachable = false
let organizationId: string
let ownerUserId: string

const FUNDING = 10_000_000n

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
    .values({ id: ownerUserId, email: `holds-${ownerUserId}@test.invalid`, name: "Holds Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Holds Test Org",
      slug: `holds-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()

  await post(db, {
    organizationId,
    kind: "topup",
    idempotencyKey: `holds-funding-${organizationId}`,
    postings: [
      { account: "stripe_clearing", amount: -FUNDING },
      { account: "user_credit", amount: FUNDING },
    ],
  })
})

afterAll(async () => {
  if (!reachable || !organizationId) return

  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("creditHold").where("organizationId", "=", organizationId).execute()
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

describe("placeHold", () => {
  it("reserves against the spendable balance without moving money", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 1_000_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })

    // The balance a caller may spend drops, but nothing has been posted: this is a reservation.
    expect(await availableBalance(db, organizationId)).toBe(before - 1_000_000n)
    await releaseHold(db, holdId)
    expect(await availableBalance(db, organizationId)).toBe(before)
  })

  it("refuses to reserve more than is available", async ({ skip }) => {
    if (!reachable) skip()
    const available = await availableBalance(db, organizationId)
    await expect(
      placeHold(db, {
        organizationId,
        amount: available + 1n,
        resourceType: "agent_run",
        ttlSeconds: 600,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)
  })

  it("counts an existing hold when deciding whether the next one fits", async ({ skip }) => {
    if (!reachable) skip()
    const available = await availableBalance(db, organizationId)

    const first = await placeHold(db, {
      organizationId,
      amount: available,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })

    // Without this, two runs would each see the full balance and together overdraw it.
    await expect(
      placeHold(db, { organizationId, amount: 1n, resourceType: "agent_run", ttlSeconds: 600 }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError)

    await releaseHold(db, first.holdId)
  })

  it("refuses a hold for nothing", async ({ skip }) => {
    if (!reachable) skip()
    await expect(
      placeHold(db, { organizationId, amount: 0n, resourceType: "agent_run", ttlSeconds: 600 }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})

describe("settleHold", () => {
  it("charges what the work cost, not what was reserved", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 2_000_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })

    await settleHold(db, { holdId, actual: 250_000n, idempotencyKey: key() })

    // Reserved 2.00, spent 0.25, and the unused 1.75 comes straight back.
    expect(await availableBalance(db, organizationId)).toBe(before - 250_000n)
  })

  it("posts overhead as its own entry", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 1_000_000n,
      resourceType: "repo_analysis",
      ttlSeconds: 600,
    })
    await settleHold(db, {
      holdId,
      actual: 100_000n,
      overheadAmount: 12_000n,
      idempotencyKey: key(),
    })

    expect(await availableBalance(db, organizationId)).toBe(before - 112_000n)
  })

  it("caps an overrun at prepaid credit and never creates debt for a later top-up", async ({
    skip,
  }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 100_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })
    const settlement = await settleHold(db, {
      holdId,
      actual: before + 300_000n,
      idempotencyKey: key(),
    })

    expect(settlement.chargedMicroUsd).toBe(before)
    expect(await availableBalance(db, organizationId)).toBe(0n)

    await post(db, {
      organizationId,
      kind: "topup",
      idempotencyKey: key(),
      postings: [
        { account: "stripe_clearing", amount: -FUNDING },
        { account: "user_credit", amount: FUNDING },
      ],
    })
    expect(await availableBalance(db, organizationId)).toBe(FUNDING)
  })

  it("releases rather than posting an all-zero transaction", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 500_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })
    const result = await settleHold(db, { holdId, actual: 0n, idempotencyKey: key() })

    expect(result.created).toBe(false)
    expect(await availableBalance(db, organizationId)).toBe(before)

    const hold = await db
      .selectFrom("creditHold")
      .select("status")
      .where("id", "=", holdId)
      .executeTakeFirstOrThrow()
    expect(hold.status).toBe("released")
  })

  it("refuses to settle the same hold twice", async ({ skip }) => {
    if (!reachable) skip()
    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 500_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })
    await settleHold(db, { holdId, actual: 100_000n, idempotencyKey: key() })

    // A retried runner must not charge a second time.
    await expect(
      settleHold(db, { holdId, actual: 100_000n, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(HoldNotActiveError)
  })
})

describe("expireHolds", () => {
  it("frees a balance a vanished runner would otherwise strand", async ({ skip }) => {
    if (!reachable) skip()
    const before = await availableBalance(db, organizationId)

    const { holdId } = await placeHold(db, {
      organizationId,
      amount: 1_000_000n,
      resourceType: "agent_run",
      ttlSeconds: 600,
    })
    await db
      .updateTable("creditHold")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", holdId)
      .execute()

    expect(await expireHolds(db)).toBeGreaterThanOrEqual(1)
    // Deliberately no charge: a hold nobody closed has no known cost, and inventing one would
    // bill for work we cannot describe.
    expect(await availableBalance(db, organizationId)).toBe(before)

    await expect(
      settleHold(db, { holdId, actual: 1n, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(HoldNotActiveError)
  })
})
