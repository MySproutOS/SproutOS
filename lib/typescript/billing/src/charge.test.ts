import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { acquirePlatformJobLock, releasePlatformJobLock } from "./test-lock"
import { assertSingleGrain, CHARGED_BUCKET, chargeUsage, MultipleGrainsError } from "./charge"
import { availableBalance, post } from "./ledger"
import { rollUpUsage, LATE_ARRIVAL_GRACE_MS } from "./rollup"

/**
 * Against the docker-compose Postgres, for the reason `rollup.test.ts` gives: every property worth
 * asserting is a database property. Here it is also that the ledger has to balance, which is only
 * true if the rows really land.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let projectId: string
let repositoryId: string

/** Outside the rollup's late-arrival grace, without depending on how long the suite takes. */
const CLOSED = new Date(Date.now() - LATE_ARRIVAL_GRACE_MS - 60_000)

let seq = 0
async function event(quantity: string, at: Date = CLOSED): Promise<void> {
  const id = v7()
  seq += 1
  await db
    .insertInto("usageEvent")
    .values({
      id,
      organizationId,
      projectId,
      resourceType: "site",
      dimension: "site_vcpu_second",
      quantity,
      occurredAt: at,
      source: "metering-agent",
      externalId: `charge-test-${id}-${seq}`,
    })
    .execute()
}

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  // Both this file and its sibling drive platform-wide sweeps. See `test-lock.ts`.
  await acquirePlatformJobLock()

  ownerUserId = v7()
  organizationId = v7()
  projectId = v7()
  repositoryId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `charge-${ownerUserId}@test.invalid`, name: "Charge Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Charge Test Org",
      slug: `charge-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Date.now() % 1_000_000_000,
      ownerLogin: "charge-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Charge Test Project",
      slug: `charge-test-${projectId.slice(-12)}`,
    })
    .execute()

  // Something to spend. Without a top-up the balance simply goes negative, which is correct
  // behaviour and makes the assertions below less legible.
  await post(db, {
    organizationId,
    kind: "topup",
    idempotencyKey: `charge-test-topup-${organizationId}`,
    postings: [
      { account: "user_credit", amount: 10_000_000n },
      { account: "stripe_clearing", amount: -10_000_000n },
    ],
  })
})

afterAll(async () => {
  if (reachable) await releasePlatformJobLock()
  if (!reachable || !organizationId) return

  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    /*
      Scoped to this organization's accounts.

      The first version was `deleteFrom("creditLedgerEntry").execute()` with no `where` — every
      ledger entry in the database, belonging to every test file running in parallel against it. It
      took `holds.test.ts` down with it, and the failure it produced there ("frees a balance a
      vanished runner would otherwise strand") pointed at that file rather than at this one.
    */
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
    await tx.deleteFrom("usageRollup").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("usageEvent").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

/**
 * What one charge run cost **this** organization.
 *
 * `chargeUsage` charges every organization that owes something, so `ChargeResult.chargedMicroUsd`
 * is a platform-wide total. Vitest runs test files in parallel against one database, and
 * `rollup.test.ts` creates an organization with metered usage of its own — so asserting on that
 * total passes alone and fails in a full run, with a number that looks like a rounding bug rather
 * than like another file's customer.
 *
 * The balance delta is the honest measurement, and it is the number that matters anyway.
 */
async function chargedHere(run: () => Promise<unknown>): Promise<bigint> {
  const before = await availableBalance(db, organizationId)
  await run()
  return before - (await availableBalance(db, organizationId))
}

/*
  The bug this guard exists for produces no error of its own.

  `rollUpUsage` writes the same usage at minute, hour and day grain. A charge that summed across
  buckets would bill everything three times, and everything downstream would agree with itself: the
  arithmetic is consistent, the ledger balances, the statement adds up. The only wrong number is the
  one the customer pays.
*/
describe("charging exactly one grain", () => {
  it("accepts the hour bucket", () => {
    expect(() => {
      assertSingleGrain([CHARGED_BUCKET, CHARGED_BUCKET])
    }).not.toThrow()
  })

  it("accepts an empty claim", () => {
    expect(() => {
      assertSingleGrain([])
    }).not.toThrow()
  })

  it("refuses a mix of grains", () => {
    expect(() => {
      assertSingleGrain(["hour", "day"])
    }).toThrow(MultipleGrainsError)
  })

  it("refuses a single grain that is not the charged one", () => {
    expect(() => {
      assertSingleGrain(["day"])
    }).toThrow(MultipleGrainsError)
    expect(() => {
      assertSingleGrain(["minute"])
    }).toThrow(MultipleGrainsError)
  })
})

describe("chargeUsage", () => {
  it("turns rolled-up usage into a ledger charge", async ({ skip }) => {
    if (!reachable) skip()

    await event("100")
    await event("50")
    await rollUpUsage(db)

    const charged = await chargedHere(() => chargeUsage(db))
    expect(charged).toBeGreaterThan(0n)
  })

  /*
    The whole point of `rated_transaction_id`, and it had no writer at all before this.

    A second run must charge nothing: the rows are stamped, so they are not claimed again. Without
    it a job that runs hourly bills the same hour every hour, forever.
  */
  it("does not charge the same grain twice", async ({ skip }) => {
    if (!reachable) skip()

    expect(await chargedHere(() => chargeUsage(db))).toBe(0n)
  })

  it("stamps only the hour rows, because only those were charged", async ({ skip }) => {
    if (!reachable) skip()

    const rows = await db
      .selectFrom("usageRollup")
      .select(["bucket", "ratedTransactionId"])
      .where("organizationId", "=", organizationId)
      .execute()

    const charged = rows.filter((row) => row.ratedTransactionId !== null)
    expect(charged.length).toBeGreaterThan(0)
    expect([...new Set(charged.map((row) => row.bucket))]).toEqual([CHARGED_BUCKET])

    // And the other grains are untouched, which is what makes the total right rather than tripled.
    const untouched = rows.filter((row) => row.bucket !== CHARGED_BUCKET)
    expect(untouched.every((row) => row.ratedTransactionId === null)).toBe(true)
  })

  /*
    Usage that arrives after its hour was charged.

    `rollUpUsage` upserts, so a late event adds to a grain that has already been billed. The metering
    agent has a retry buffer, so an event delayed past the rollup's five-minute grace by a restart or
    a partition is ordinary rather than exceptional.

    Two separate bugs lived here and this case found both. The claim looked for
    `rated_transaction_id is null`, so a topped-up grain was never looked at again and the addition
    was free. Fixing that surfaced the second: the idempotency key was the row ids and their count,
    which are *identical* for the re-charge — so the key matched the first transaction, `postWithin`
    returned it having written nothing, and the job reported a charge that never happened.

    The charge must be for the difference, and only for the difference.
  */
  it("charges the difference when usage lands in an already-charged hour", async ({ skip }) => {
    if (!reachable) skip()

    await event("40")
    await rollUpUsage(db)
    const first = await chargedHere(() => chargeUsage(db))
    expect(first).toBeGreaterThan(0n)

    // The late arrival, into the same hour.
    await event("40")
    await rollUpUsage(db)
    const second = await chargedHere(() => chargeUsage(db))

    // The same quantity as the first charge, so the same money — not the grain's new total, and
    // not nothing.
    expect(second).toBe(first)

    // And a third run, with nothing new, charges nothing.
    expect(await chargedHere(() => chargeUsage(db))).toBe(0n)
  })

  /*
    Agent usage: visible on a statement, charged exactly once.

    An agent run settles its own hold, so the tokens are paid for before they are ever rolled up.
    That used to be expressed by stamping `rated_at` at write time — which meant "already charged"
    to the agent and "already folded into `usage_rollup`" to the rollup, so those events were
    skipped entirely. Both the statement and the dashboard's project cost are built from
    `usage_rollup`, so **AI tokens, the largest line in this product, appeared on no statement at
    all** while the customer was charged for them.

    The two facts are two columns now. This asserts both halves: the usage reaches the rollup, and
    the charge job does not bill it a second time.
  */
  it("rolls up agent usage without charging for it again", async ({ skip }) => {
    if (!reachable) skip()

    const before = await availableBalance(db, organizationId)

    const id = v7()
    seq += 1
    await db
      .insertInto("usageEvent")
      .values({
        id,
        organizationId,
        projectId,
        resourceType: "agent",
        dimension: "ai_input_token",
        quantity: "1000",
        occurredAt: CLOSED,
        source: "agent",
        externalId: `charge-test-agent-${id}-${seq}`,
        // What the agent sets: the hold already took the money.
        chargedExternally: true,
      })
      .execute()

    await rollUpUsage(db)

    const grain = await db
      .selectFrom("usageRollup")
      .select(["quantity", "chargedQuantity"])
      .where("organizationId", "=", organizationId)
      .where("dimension", "=", "ai_input_token")
      .where("bucket", "=", "day")
      .executeTakeFirst()

    // Visible — this is what a statement itemizes.
    expect(Number(grain?.quantity)).toBe(1000)
    // And already paid for, so `chargeUsage` has nothing to claim.
    expect(Number(grain?.chargedQuantity)).toBe(1000)

    await chargeUsage(db)
    expect(await availableBalance(db, organizationId)).toBe(before)
  })

  /*
    The charge is posted, not spent.

    The compute has already been consumed. Refusing to record it does not un-run the pods; it loses
    the revenue and leaves the ledger disagreeing with the world. Stopping a customer before they
    overdraw is what holds are for.
  */
  it("charges past a balance of zero rather than refusing", async ({ skip }) => {
    if (!reachable) skip()

    // Spend the balance down to nothing, then meter more usage.
    const balance = await availableBalance(db, organizationId)
    if (balance > 0n) {
      await post(db, {
        organizationId,
        kind: "adjustment",
        idempotencyKey: `charge-test-drain-${organizationId}`,
        postings: [
          { account: "user_credit", amount: -balance },
          { account: "platform_revenue", amount: balance },
        ],
      })
    }
    expect(await availableBalance(db, organizationId)).toBe(0n)

    await event("250")
    await rollUpUsage(db)
    expect(await chargedHere(() => chargeUsage(db))).toBeGreaterThan(0n)
    expect(await availableBalance(db, organizationId)).toBeLessThan(0n)
  })
})
