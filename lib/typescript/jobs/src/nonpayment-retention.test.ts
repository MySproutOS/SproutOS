import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { deleteNonpaymentData, scanNonpaymentRetention } from "./nonpayment-retention"
import type { Job } from "./queue"

const userId = v7()
const organizationId = v7()
const repositoryId = v7()
const generation = v7()
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }

beforeAll(async () => {
  if (!reachable) return
  await db
    .insertInto("user")
    .values({ id: userId, email: `nonpayment-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      ownerUserId: userId,
      name: "Nonpayment retry",
      slug: `nonpayment-${organizationId.slice(-12)}`,
      kind: "team",
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "retention-test",
      name: `preserved-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
})

beforeEach(async () => {
  if (!reachable) return
  await db.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
  await db.deleteFrom("creditRetentionState").where("organizationId", "=", organizationId).execute()
})

afterAll(async () => {
  if (!reachable) return
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = 'replica'`.execute(trx)
    await trx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await trx
      .deleteFrom("retentionNoticeDelivery")
      .where("organizationId", "=", organizationId)
      .execute()
    await trx
      .deleteFrom("creditRetentionState")
      .where("organizationId", "=", organizationId)
      .execute()
    await trx.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await trx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await trx.deleteFrom("user").where("id", "=", userId).execute()
  })
})

describe.skipIf(!reachable)("nonpayment retention", () => {
  it("enqueues one generation-scoped deletion job across repeated scans", async () => {
    const exhaustedAt = new Date(Date.now() - 49 * 60 * 60 * 1000)
    await db
      .insertInto("creditRetentionState")
      .values({
        organizationId,
        generation,
        status: "suspended",
        warningStage: "deletion_imminent",
        exhaustedAt,
        deleteAfter: new Date(exhaustedAt.getTime() + 48 * 60 * 60 * 1000),
      })
      .execute()

    const scanJob = { id: v7(), kind: "billing.scan_nonpayment_retention", payload: {} } as Job
    await scanNonpaymentRetention(scanJob, context)
    await scanNonpaymentRetention(scanJob, context)

    const jobs = await db
      .selectFrom("backgroundJob")
      .select(["kind", "payload", "idempotencyKey"])
      .where("organizationId", "=", organizationId)
      .execute()
    expect(jobs).toEqual([
      {
        kind: "billing.delete_nonpayment_data",
        payload: { organizationId, generation },
        idempotencyKey: `billing.delete_nonpayment_data:${organizationId}:${generation}`,
      },
    ])
  })

  it("resumes an irreversible claim without moving its cutoff and never touches GitHub", async () => {
    const deletionStartedAt = new Date(Date.now() - 60_000)
    const deleteAfter = new Date(Date.now() - 120_000)
    await db
      .insertInto("creditRetentionState")
      .values({
        organizationId,
        generation,
        status: "deleting",
        warningStage: "deleting",
        exhaustedAt: new Date(deleteAfter.getTime() - 48 * 60 * 60 * 1000),
        deleteAfter,
        deletionStartedAt,
      })
      .execute()

    const deleteJob = {
      id: v7(),
      kind: "billing.delete_nonpayment_data",
      payload: { organizationId, generation },
    } as Job
    const handler = deleteNonpaymentData()
    await handler(deleteJob, context)
    await handler(deleteJob, context)

    await expect(
      db
        .selectFrom("creditRetentionState")
        .select(["status", "deletionStartedAt"])
        .where("organizationId", "=", organizationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "data_deleted", deletionStartedAt })
    await expect(
      db.selectFrom("repository").select("id").where("id", "=", repositoryId).executeTakeFirst(),
    ).resolves.toEqual({ id: repositoryId })
  })
})
