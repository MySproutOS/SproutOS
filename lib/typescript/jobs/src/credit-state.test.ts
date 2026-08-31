import { post } from "@lib/billing"
import { readCreditState } from "@lib/lambda"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { refreshCreditStates, refreshOrganizationCreditState } from "./credit-state"
import type { Job } from "./queue"

const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    await valkey.connect()
    return true
  } catch {
    return false
  }
})()
const ownerUserId = v7()
const fundedId = v7()
const exhaustedId = v7()
const reservedId = v7()
const storageServiceId = v7()
let regionId = ""

beforeAll(async () => {
  if (!reachable) return

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `credit-state-${ownerUserId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values([
      {
        id: fundedId,
        name: "Funded credit state",
        slug: `credit-funded-${fundedId.slice(-12)}`,
        kind: "team",
        ownerUserId,
      },
      {
        id: exhaustedId,
        name: "Exhausted credit state",
        slug: `credit-empty-${exhaustedId.slice(-12)}`,
        kind: "team",
        ownerUserId,
      },
      {
        id: reservedId,
        name: "Storage-reserved credit state",
        slug: `credit-reserved-${reservedId.slice(-12)}`,
        kind: "team",
        ownerUserId,
      },
    ])
    .execute()

  await post(db, {
    organizationId: fundedId,
    kind: "topup",
    idempotencyKey: `credit-state:${fundedId}`,
    postings: [
      { account: "stripe_clearing", amount: -1_000_000n },
      { account: "user_credit", amount: 1_000_000n },
    ],
  })
  await post(db, {
    organizationId: reservedId,
    kind: "topup",
    idempotencyKey: `credit-state:${reservedId}`,
    postings: [
      { account: "stripe_clearing", amount: -1_000n },
      { account: "user_credit", amount: 1_000n },
    ],
  })
  regionId = (
    await db
      .selectFrom("region")
      .select("id")
      .where("code", "=", "us-east-1")
      .executeTakeFirstOrThrow()
  ).id
  await db
    .insertInto("backendService")
    .values({
      id: storageServiceId,
      organizationId: reservedId,
      kind: "object_storage",
      name: "Reserved bytes",
      status: "active",
      regionId,
    })
    .execute()
  await db
    .insertInto("objectStorageMeteringState")
    .values({
      backendServiceId: storageServiceId,
      // One decimal TB needs about $1.48 for forty-eight August hours, above this fixture's $0.001.
      currentBytes: 1_000_000_000_000n,
      meteredThrough: new Date(),
      measuredAt: new Date(),
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await valkey.del(`credit:${fundedId}`, `credit:${exhaustedId}`, `credit:${reservedId}`)
  await valkey.quit()
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("creditLedgerEntry")
      .where((eb) =>
        eb(
          "creditAccountId",
          "in",
          eb
            .selectFrom("creditAccount")
            .select("id")
            .where("organizationId", "in", [fundedId, exhaustedId, reservedId]),
        ),
      )
      .execute()
    await tx
      .deleteFrom("creditTransaction")
      .where("organizationId", "in", [fundedId, exhaustedId, reservedId])
      .execute()
    await tx
      .deleteFrom("creditAccount")
      .where("organizationId", "in", [fundedId, exhaustedId, reservedId])
      .execute()
    await tx
      .deleteFrom("creditRetentionState")
      .where("organizationId", "in", [fundedId, exhaustedId, reservedId])
      .execute()
    await tx
      .deleteFrom("objectStorageMeteringState")
      .where("backendServiceId", "=", storageServiceId)
      .execute()
    await tx.deleteFrom("backendService").where("id", "=", storageServiceId).execute()
    await tx
      .deleteFrom("organization")
      .where("id", "in", [fundedId, exhaustedId, reservedId])
      .execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }
const job = { id: v7(), kind: "billing.refresh_credit_states" } as Job

describe.skipIf(!reachable)("refreshCreditStates", () => {
  it("publishes exhausted and actively clears a funded organization's stale refusal", async () => {
    await valkey.set(`credit:${fundedId}`, "exhausted", "EX", 900)

    await refreshCreditStates({ valkey })(job, context)

    expect(await readCreditState(valkey, fundedId)).toBeUndefined()
    expect(await readCreditState(valkey, exhaustedId)).toBe("exhausted")
    expect(await readCreditState(valkey, reservedId)).toBe("exhausted")
    expect(await valkey.ttl(`credit:${exhaustedId}`)).toBeGreaterThan(10 * 60)
  })

  it("records one fixed 48-hour deadline and clears it after enough credit is added", async () => {
    const first = await db
      .selectFrom("creditRetentionState")
      .select(["reserveMicroUsd", "exhaustedAt", "deleteAfter"])
      .where("organizationId", "=", reservedId)
      .executeTakeFirstOrThrow()
    expect(BigInt(first.reserveMicroUsd)).toBeGreaterThan(1_000n)
    expect(first.exhaustedAt).not.toBeNull()
    expect(first.deleteAfter!.getTime() - first.exhaustedAt!.getTime()).toBe(48 * 60 * 60 * 1000)

    await refreshOrganizationCreditState(db, valkey, reservedId)
    const unchanged = await db
      .selectFrom("creditRetentionState")
      .select("deleteAfter")
      .where("organizationId", "=", reservedId)
      .executeTakeFirstOrThrow()
    expect(unchanged.deleteAfter).toEqual(first.deleteAfter)

    await post(db, {
      organizationId: reservedId,
      kind: "topup",
      idempotencyKey: `credit-state:restore:${reservedId}`,
      postings: [
        { account: "stripe_clearing", amount: -2_000_000n },
        { account: "user_credit", amount: 2_000_000n },
      ],
    })
    await refreshOrganizationCreditState(db, valkey, reservedId)
    expect(await readCreditState(valkey, reservedId)).toBeUndefined()
    await expect(
      db
        .selectFrom("creditRetentionState")
        .select(["exhaustedAt", "deleteAfter"])
        .where("organizationId", "=", reservedId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ exhaustedAt: null, deleteAfter: null })
  })
})
