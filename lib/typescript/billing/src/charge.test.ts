import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { acquirePlatformJobLock, releasePlatformJobLock } from "./test-lock"
import { assertSingleGrain, CHARGED_BUCKET, chargeUsage, MultipleGrainsError } from "./charge"
import { applyImportedUsageRollups, type ImportedUsageBucket } from "./import-rollups"
import { availableBalance, post } from "./ledger"
import { rateTimesQuantity } from "./money"

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

/** A closed billing window, without depending on how long the suite takes. */
const CLOSED = new Date(Date.now() - 10 * 60_000)

const imported = new Map<string, { quantity: number; externallyCharged: number }>()

async function event(
  quantity: string,
  options: { dimension?: string; chargedExternally?: boolean } = {},
): Promise<void> {
  const dimension = options.dimension ?? "site_gib_second"
  const previous = imported.get(dimension) ?? { quantity: 0, externallyCharged: 0 }
  const next = {
    quantity: previous.quantity + Number(quantity),
    externallyCharged:
      previous.externallyCharged + (options.chargedExternally === true ? Number(quantity) : 0),
  }
  imported.set(dimension, next)

  const starts: Record<ImportedUsageBucket, Date> = {
    minute: new Date(CLOSED.toISOString().slice(0, 16) + ":00.000Z"),
    hour: new Date(CLOSED.toISOString().slice(0, 13) + ":00:00.000Z"),
    day: new Date(CLOSED.toISOString().slice(0, 10) + "T00:00:00.000Z"),
  }
  await applyImportedUsageRollups(
    db,
    (["minute", "hour", "day"] as const).map((bucket) => ({
      organizationId,
      projectId,
      dimension,
      bucket,
      bucketStart: starts[bucket],
      quantity: String(next.quantity),
      externallyChargedQuantity: String(next.externallyCharged),
    })),
    new Date(),
  )
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

  // Something to spend. The prepaid balance is a hard floor; the final tests drain it deliberately.
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

  The ClickHouse importer writes the same usage at minute, hour and day grain. A charge that summed
  across buckets would bill everything three times, and everything downstream would agree with
  itself: the arithmetic is consistent, the ledger balances, the statement adds up. The only wrong
  number is the one the customer pays.
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

    const charged = await chargedHere(() => chargeUsage(db))
    expect(charged).toBeGreaterThan(0n)
  })

  it("charges Daytona sandbox usage at provider cost with no overhead", async ({ skip }) => {
    if (!reachable) skip()

    await event("3600", { dimension: "sandbox_cpu_second" })
    const charged = await chargedHere(() => chargeUsage(db))

    expect(charged).toBe(rateTimesQuantity("14", "3600"))
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

    The importer replaces a grain with a larger absolute ClickHouse total when late usage arrives.
    The metering agent has a retry buffer, so an event delayed by a restart or partition is ordinary
    rather than exceptional.

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
    const first = await chargedHere(() => chargeUsage(db))
    expect(first).toBeGreaterThan(0n)

    // The late arrival, into the same hour.
    await event("40")
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

    await event("1000", { dimension: "ai_input_token", chargedExternally: true })

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

  it("shows BYO AI usage without debiting it and still charges platform-key AI usage", async ({
    skip,
  }) => {
    if (!reachable) skip()

    await event("123", { dimension: "ai_cache_read_token", chargedExternally: true })
    const byo = await db
      .selectFrom("usageRollup")
      .select(["quantity", "chargedQuantity", "externallyChargedQuantity"])
      .where("organizationId", "=", organizationId)
      .where("dimension", "=", "ai_cache_read_token")
      .where("bucket", "=", CHARGED_BUCKET)
      .executeTakeFirstOrThrow()

    expect(Number(byo.quantity)).toBe(123)
    expect(Number(byo.externallyChargedQuantity)).toBe(123)
    expect(Number(byo.chargedQuantity)).toBe(123)
    expect(await chargedHere(() => chargeUsage(db))).toBe(0n)

    await event("17", { dimension: "ai_output_token", chargedExternally: false })
    const platform = await db
      .selectFrom("usageRollup")
      .select(["quantity", "chargedQuantity", "externallyChargedQuantity"])
      .where("organizationId", "=", organizationId)
      .where("dimension", "=", "ai_output_token")
      .where("bucket", "=", CHARGED_BUCKET)
      .executeTakeFirstOrThrow()

    expect(Number(platform.quantity)).toBe(17)
    expect(Number(platform.externallyChargedQuantity)).toBe(0)
    expect(Number(platform.chargedQuantity)).toBe(0)
    expect(await chargedHere(() => chargeUsage(db))).toBeGreaterThan(0n)
  })

  it("caps a delayed charge at prepaid credit and creates no debt for a later top-up", async ({
    skip,
  }) => {
    if (!reachable) skip()

    // Spend the balance down to nothing, then meter more usage.
    const balance = await availableBalance(db, organizationId)
    const lastCredit = 1_000n
    if (balance > lastCredit) {
      await post(db, {
        organizationId,
        kind: "adjustment",
        idempotencyKey: `charge-test-drain-${organizationId}`,
        postings: [
          { account: "user_credit", amount: -(balance - lastCredit) },
          { account: "platform_revenue", amount: balance - lastCredit },
        ],
      })
    }
    expect(await availableBalance(db, organizationId)).toBe(lastCredit)

    // More than the final credit after rating and overhead, so this must exercise the cap rather
    // than merely happen to leave a small positive remainder.
    await event("1000")
    expect(await chargedHere(() => chargeUsage(db))).toBe(lastCredit)
    expect(await availableBalance(db, organizationId)).toBe(0n)

    const settled = await db
      .selectFrom("usageRollup")
      .select(["quantity", "chargedQuantity"])
      .where("organizationId", "=", organizationId)
      .where("dimension", "=", "site_gib_second")
      .where("bucket", "=", CHARGED_BUCKET)
      .executeTakeFirstOrThrow()
    expect(settled.chargedQuantity).toBe(settled.quantity)

    await post(db, {
      organizationId,
      kind: "topup",
      idempotencyKey: `charge-test-later-topup-${organizationId}`,
      postings: [
        { account: "user_credit", amount: 1_000_000n },
        { account: "stripe_clearing", amount: -1_000_000n },
      ],
    })
    await chargeUsage(db)
    expect(await availableBalance(db, organizationId)).toBe(1_000_000n)
  })
})
