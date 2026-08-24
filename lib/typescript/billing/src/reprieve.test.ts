import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { post } from "./ledger"
import { type AutoChargeSettings, decideReprieve } from "./reprieve"

/**
 * The last check before a customer's data is destroyed.
 *
 * Against the real Postgres, because the thing under test is a balance read at a particular moment
 * and a fake ledger would let the moment be whatever the test wanted.
 */
/*
  Resolved at module scope, not in `beforeAll`.

  `describe.runIf` is evaluated when the file is collected, which happens before any hook runs — so
  a flag set in `beforeAll` is still `false` when the decision is made and the whole suite skips
  silently. It reports "6 skipped" and a green run, which is exactly the failure mode this
  repository keeps writing findings about.
*/
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: string[] = []
let ownerUserId = ""

async function organization(funded: bigint): Promise<string> {
  const organizationId = v7()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Reprieve Test Org",
      slug: `reprieve-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  created.push(organizationId)

  if (funded > 0n) {
    await post(db, {
      organizationId,
      kind: "topup",
      idempotencyKey: `reprieve-funding-${organizationId}`,
      postings: [
        { account: "stripe_clearing", amount: -funded },
        { account: "user_credit", amount: funded },
      ],
    })
  }

  return organizationId
}

const OFF: AutoChargeSettings = {
  enabled: false,
  ceilingMicroUsd: 0n,
  chargedSoFarMicroUsd: 0n,
}
const ON: AutoChargeSettings = {
  enabled: true,
  ceilingMicroUsd: 5_000_000n,
  chargedSoFarMicroUsd: 0n,
}

beforeAll(async () => {
  if (!reachable) return

  ownerUserId = v7()
  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `reprieve-${ownerUserId}@test.invalid` })
    .execute()
})

afterAll(async () => {
  if (!reachable) return

  // The same order and the same `session_replication_role` dance as `holds.test.ts`: the ledger is
  // append-only in production and its foreign keys say so, so a test tearing itself down has to
  // suspend them rather than pretend the rows were never written.
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    for (const organizationId of created) {
      await tx
        .deleteFrom("creditLedgerEntry")
        .where((eb) =>
          eb(
            "creditAccountId",
            "in",
            eb
              .selectFrom("creditAccount")
              .select("id")
              .where("organizationId", "=", organizationId),
          ),
        )
        .execute()
      await tx
        .deleteFrom("creditTransaction")
        .where("organizationId", "=", organizationId)
        .execute()
      await tx.deleteFrom("creditAccount").where("organizationId", "=", organizationId).execute()
      await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    }
    if (ownerUserId) await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })

  await db.destroy()
})

describe.runIf(reachable)("decideReprieve", () => {
  it("spares a customer who topped up during the grace period", async () => {
    /*
      The bug this module exists to prevent.

      The obvious implementation decides at hour zero and deletes at hour forty-eight. A customer
      who pays at hour forty-seven — who can see their credit, whose dashboard says they are fine —
      loses everything anyway, because the decision was taken against a number that has since
      changed. Reading now is the whole point.
    */
    const organizationId = await organization(1_000_000n)

    const decision = await decideReprieve(db, organizationId, OFF, () => Promise.resolve(false))

    expect(decision.outcome).toBe("reprieved")
    expect(decision).toMatchObject({ reason: "balance_restored" })
  })

  it("deletes a customer who never paid and never asked us to charge them", async () => {
    const organizationId = await organization(0n)

    expect(await decideReprieve(db, organizationId, OFF, () => Promise.resolve(false))).toEqual({
      outcome: "delete",
      reason: "auto_charge_disabled",
    })
  })

  it("charges before deleting, when the customer asked us to", async () => {
    // Someone with auto-charge on has told us to take money rather than let this happen. Deleting
    // without trying is deleting the data of a customer who asked us to prevent exactly this.
    const organizationId = await organization(0n)
    let attempted = false

    const decision = await decideReprieve(db, organizationId, ON, async (id) => {
      attempted = true
      expect(id).toBe(organizationId)
      await post(db, {
        organizationId,
        kind: "topup",
        idempotencyKey: `reprieve-auto-${organizationId}`,
        postings: [
          { account: "stripe_clearing", amount: -2_000_000n },
          { account: "user_credit", amount: 2_000_000n },
        ],
      })
      return true
    })

    expect(attempted).toBe(true)
    expect(decision).toMatchObject({ outcome: "reprieved", reason: "auto_charge_succeeded" })
  })

  it("deletes when the charge is declined", async () => {
    // An expired or declined card. At this point the customer really has not paid, and has had two
    // days' notice.
    const organizationId = await organization(0n)

    expect(await decideReprieve(db, organizationId, ON, () => Promise.resolve(false))).toEqual({
      outcome: "delete",
      reason: "auto_charge_failed",
    })
  })

  it("does not charge past the ceiling the customer set", async () => {
    /*
      The ceiling is the customer's own limit on what we may take. Charging past it to save their
      data would be spending money they explicitly told us not to spend — a kindness that is also a
      violation, and one they would find on a statement.
    */
    const organizationId = await organization(0n)
    let attempted = false

    const decision = await decideReprieve(
      db,
      organizationId,
      { enabled: true, ceilingMicroUsd: 1_000_000n, chargedSoFarMicroUsd: 1_000_000n },
      () => {
        attempted = true
        return Promise.resolve(true)
      },
    )

    expect(attempted).toBe(false)
    expect(decision.outcome).toBe("delete")
  })

  it("does not trust a charge that reported success but left no credit", async () => {
    // The charger reports whether the payment succeeded. What decides this is whether the ledger
    // now shows money — a payment that succeeded and did not land as credit is not a reprieve.
    const organizationId = await organization(0n)

    expect(await decideReprieve(db, organizationId, ON, () => Promise.resolve(true))).toEqual({
      outcome: "delete",
      reason: "still_unpaid",
    })
  })
})
