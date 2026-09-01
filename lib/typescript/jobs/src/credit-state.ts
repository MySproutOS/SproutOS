import { availableBalance, organizationBurnPerDay, rateTimesQuantity } from "@lib/billing"
import { crudRetentionNoticeDelivery, fetchRetentionNoticeDelivery } from "@lib/dao"
import { clearCreditState, publishCreditState } from "@lib/lambda"
import { Redis } from "ioredis"
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import type { JobHandler } from "./worker"
import { enqueue } from "./queue"
import { SANDBOX_KINDS } from "./sandbox"
import { enqueueStaticAccessReconciliation } from "./static-suspension"
import {
  OBJECT_STORAGE_RETENTION_SECONDS,
  objectStorageReserveMicroUsd,
} from "./object-storage-metering"

/**
 * Refresh the router's short-lived view of whether an organization may spend.
 *
 * This deliberately implements credit exhaustion only. There is no product plan or per-dimension
 * quota model yet, so inventing one here would turn an unaudited threshold into an outage. A
 * positive spendable balance serves; zero or less is exhausted. The router still fails open when
 * this projection is absent or Valkey cannot be read.
 */
export const REFRESH_CREDIT_STATES_KIND = "billing.refresh_credit_states"

let shared: Redis | undefined
function valkey(): Redis {
  shared ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return shared
}

export function refreshCreditStates(options?: { valkey: Redis }): JobHandler {
  return async (_job, { db }) => {
    const client = options?.valkey ?? valkey()
    const organizations = await db
      .selectFrom("organization")
      .select("id")
      .where("deletedAt", "is", null)
      .execute()

    let exhausted = 0
    for (const organization of organizations) {
      // Keep writes bounded instead of bursting every organization at the cache simultaneously.
      // eslint-disable-next-line no-await-in-loop
      if (await refreshOrganizationCreditState(db, client, organization.id)) exhausted += 1
    }

    console.info(
      `[billing] refreshed credit state for ${organizations.length} organization(s), ${exhausted} exhausted`,
    )
  }
}

/** Refresh one organization immediately after a balance-changing operation such as a top-up. */
export async function refreshOrganizationCreditState(
  db: Kysely<DB>,
  client: Redis,
  organizationId: string,
): Promise<boolean> {
  const state = await db.transaction().execute(async (trx) => {
    // The sweep and organization deletion are both background work. Hold the parent row while the
    // FK-backed projection is written, so an organization selected a moment before deletion is a
    // harmless skip rather than a failed global billing sweep.
    const organization = await trx
      .selectFrom("organization")
      .select("id")
      .where("id", "=", organizationId)
      .where("deletedAt", "is", null)
      .forUpdate()
      .executeTakeFirst()
    if (organization === undefined) return undefined

    const balance = await availableBalance(trx, organizationId)
    const reserve = await protectedRetentionReserve(trx, organizationId)
    const burnPerDay = await organizationBurnPerDay(trx, organizationId)
    const previous = await trx
      .selectFrom("creditRetentionState")
      .select(["status", "warningStage", "generation", "deleteAfter"])
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
    // Once irreversible cleanup has been claimed, only that workflow may move the lifecycle.
    // A five-minute balance refresh must never resurrect provider data or rewrite its evidence.
    if (previous?.status === "deleting" || previous?.status === "data_deleted") {
      return true
    }
    const now = new Date()
    const exhausted = balance <= reserve
    const generation = previous?.generation ?? v7()
    const deleteAfter = exhausted
      ? (previous?.deleteAfter ?? new Date(now.getTime() + OBJECT_STORAGE_RETENTION_SECONDS * 1000))
      : null
    const warningStage = retentionWarningStage({
      balance,
      reserve,
      burnPerDay,
      deleteAfter,
      status: exhausted ? "suspended" : "active",
      now,
    })
    const status = exhausted ? "suspended" : "active"

    await trx
      .insertInto("creditRetentionState")
      .values({
        organizationId,
        reserveMicroUsd: reserve,
        reserveMeasuredAt: now,
        status,
        warningStage,
        generation: warningStage === "safe" ? null : generation,
        exhaustedAt: exhausted ? now : null,
        deleteAfter,
        deletionStartedAt: null,
        deletionCompletedAt: null,
      })
      .onConflict((conflict) =>
        conflict.column("organizationId").doUpdateSet(
          exhausted
            ? {
                reserveMicroUsd: reserve,
                reserveMeasuredAt: now,
                status,
                warningStage,
                generation,
                // Never move an existing deadline forward merely because the five-minute refresh
                // ran again. A top-up clears it; a later exhaustion begins a new window.
                exhaustedAt: sql`coalesce(credit_retention_state.exhausted_at, ${now})`,
                deleteAfter: sql`coalesce(credit_retention_state.delete_after, ${new Date(
                  now.getTime() + OBJECT_STORAGE_RETENTION_SECONDS * 1000,
                )})`,
                updatedAt: now,
              }
            : {
                reserveMicroUsd: reserve,
                reserveMeasuredAt: now,
                status,
                warningStage,
                generation: warningStage === "safe" ? null : generation,
                exhaustedAt: null,
                deleteAfter: null,
                deletionStartedAt: null,
                deletionCompletedAt: null,
                updatedAt: now,
              },
        ),
      )
      .execute()

    const noticeStage = noticeForTransition(previous?.warningStage ?? "safe", warningStage)
    if (noticeStage !== null) {
      await queueRetentionNotice(trx, organizationId, generation, noticeStage)
    }
    if (previous?.status === "suspended" && !exhausted && previous.generation !== null) {
      await queueRetentionNotice(trx, organizationId, previous.generation, "reprieved")
      await enqueueStaticAccessReconciliation(trx, {
        organizationId,
        generation: previous.generation,
        suspended: false,
      })
    }
    if (exhausted && previous?.status !== "suspended") {
      await enqueueStaticAccessReconciliation(trx, {
        organizationId,
        generation,
        suspended: true,
      })
      const sandboxes = await trx
        .selectFrom("sandbox")
        .innerJoin("project", "project.id", "sandbox.projectId")
        .select("sandbox.id")
        .where("project.organizationId", "=", organizationId)
        .where("sandbox.state", "in", ["starting", "running", "idle", "failed"])
        .execute()
      for (const sandbox of sandboxes) {
        await enqueue(trx, {
          kind: SANDBOX_KINDS.stop,
          organizationId,
          payload: { sandboxId: sandbox.id, meterThrough: now.toISOString() },
          idempotencyKey: `nonpayment-stop:${generation}:${sandbox.id}`,
          maxAttempts: 10,
        })
      }
    }
    return exhausted
  })

  if (state === undefined) {
    await clearCreditState(client, organizationId)
    return false
  }

  if (state) {
    await publishCreditState(client, organizationId, "exhausted")
    return true
  }

  // A top-up must actively remove an earlier refusal; waiting for the TTL would leave a paying
  // customer offline after Stripe has already confirmed their payment.
  await clearCreditState(client, organizationId)
  return false
}

export type RetentionWarningStage =
  | "safe"
  | "warning"
  | "critical"
  | "suspended"
  | "deletion_imminent"
  | "deleting"
  | "data_deleted"

export function retentionWarningStage(input: {
  balance: bigint
  reserve: bigint
  burnPerDay: bigint
  deleteAfter: Date | null
  status: string
  now?: Date
}): RetentionWarningStage {
  if (input.status === "deleting") return "deleting"
  if (input.status === "data_deleted") return "data_deleted"
  const now = input.now ?? new Date()
  if (input.balance <= input.reserve) {
    if (
      input.deleteAfter !== null &&
      input.deleteAfter.getTime() - now.getTime() <= 24 * 60 * 60 * 1000
    ) {
      return "deletion_imminent"
    }
    return "suspended"
  }
  if (input.burnPerDay <= 0n) return "safe"
  const spendable = input.balance - input.reserve
  if (spendable <= input.burnPerDay * 2n) return "critical"
  if (spendable <= input.burnPerDay * 7n) return "warning"
  return "safe"
}

function noticeForTransition(
  previous: string,
  next: RetentionWarningStage,
): "critical" | "suspended" | "deletion_imminent" | null {
  if (previous === next) return null
  if (next === "critical" || next === "suspended" || next === "deletion_imminent") return next
  return null
}

async function queueRetentionNotice(
  db: Kysely<DB>,
  organizationId: string,
  generation: string,
  stage: "critical" | "suspended" | "deletion_imminent" | "reprieved" | "data_deleted",
): Promise<void> {
  const recipients = await fetchRetentionNoticeDelivery(db).billingRecipients(organizationId)
  for (const recipient of recipients) {
    await crudRetentionNoticeDelivery(db).createOnce({
      organizationId,
      generation,
      stage,
      userId: recipient.userId,
      recipient: recipient.email,
    })
  }
}

/** Protected floor for two days of every currently measurable retained-data dimension. */
export async function protectedRetentionReserve(
  db: Kysely<DB>,
  organizationId: string,
  at: Date = new Date(),
): Promise<bigint> {
  const objectStorage = await protectedObjectStorageReserve(db, organizationId, at)
  const seconds = BigInt(OBJECT_STORAGE_RETENTION_SECONDS)
  const [valkey, sandbox] = await Promise.all([
    db
      .selectFrom("valkeyMeteringState")
      .innerJoin("backendService", "backendService.id", "valkeyMeteringState.backendServiceId")
      .select(
        sql<string>`coalesce(sum(valkey_metering_state.memory_bytes), 0)::text`.as("quantity"),
      )
      .where("backendService.organizationId", "=", organizationId)
      .where("backendService.deletedAt", "is", null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .select(sql<string>`coalesce(sum(sandbox.disk_gib), 0)::text`.as("quantity"))
      .where("project.organizationId", "=", organizationId)
      .where("sandbox.externalId", "is not", null)
      .where("sandbox.state", "in", ["starting", "running", "idle", "stopped", "deleting"])
      .executeTakeFirstOrThrow(),
  ])
  const rates = await activeRates(db, ["valkey_queue_byte_second", "sandbox_disk_gib_second"], at)
  const valkeyReserve = rateTimesQuantity(
    rates.get("valkey_queue_byte_second") ?? "0",
    (BigInt(valkey.quantity) * seconds).toString(),
  )
  const sandboxReserve = rateTimesQuantity(
    rates.get("sandbox_disk_gib_second") ?? "0",
    (BigInt(sandbox.quantity) * seconds).toString(),
  )
  const historical = await recentStorageReserve(db, organizationId, at)
  return objectStorage + valkeyReserve + sandboxReserve + historical
}

/** Refuse irreversible cleanup when a live retained-data meter has no recent durable observation. */
export async function assertRetentionInventoryFresh(
  db: Kysely<DB>,
  organizationId: string,
  at: Date = new Date(),
): Promise<void> {
  const objectBefore = new Date(at.getTime() - 2 * 60 * 60 * 1000)
  const sampleBefore = new Date(at.getTime() - 15 * 60 * 1000)
  const neonBefore = new Date(at.getTime() - 2 * 60 * 60 * 1000)
  const [objects, valkey, sandboxes, neon] = await Promise.all([
    db
      .selectFrom("backendService")
      .leftJoin(
        "objectStorageMeteringState",
        "objectStorageMeteringState.backendServiceId",
        "backendService.id",
      )
      .select(sql<number>`count(*)::int`.as("count"))
      .where("backendService.organizationId", "=", organizationId)
      .where("backendService.kind", "=", "object_storage")
      .where("backendService.deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("objectStorageMeteringState.measuredAt", "is", null),
          eb("objectStorageMeteringState.measuredAt", "<", objectBefore),
        ]),
      )
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("backendService")
      .leftJoin("valkeyMeteringState", "valkeyMeteringState.backendServiceId", "backendService.id")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("backendService.organizationId", "=", organizationId)
      .where("backendService.kind", "=", "valkey")
      .where("backendService.deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("valkeyMeteringState.sampledAt", "is", null),
          eb("valkeyMeteringState.sampledAt", "<", sampleBefore),
        ]),
      )
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("project.organizationId", "=", organizationId)
      .where("sandbox.externalId", "is not", null)
      .where((eb) =>
        eb.or([
          eb("sandbox.meteredThrough", "is", null),
          eb("sandbox.meteredThrough", "<", sampleBefore),
        ]),
      )
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("databaseBranch")
      .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
      .innerJoin("backendService", "backendService.id", "databaseInstance.backendServiceId")
      .leftJoin(
        "neonBranchMeteringState",
        "neonBranchMeteringState.databaseBranchId",
        "databaseBranch.id",
      )
      .select(sql<number>`count(*)::int`.as("count"))
      .where("backendService.organizationId", "=", organizationId)
      .where("backendService.deletedAt", "is", null)
      .where("databaseInstance.provider", "=", "neon")
      .where((eb) =>
        eb.or([
          eb("neonBranchMeteringState.meteredThrough", "is", null),
          eb("neonBranchMeteringState.meteredThrough", "<", neonBefore),
        ]),
      )
      .executeTakeFirstOrThrow(),
  ])
  const stale = [
    ["object storage", objects.count],
    ["Valkey", valkey.count],
    ["sandbox", sandboxes.count],
    ["Neon", neon.count],
  ].filter(([, count]) => Number(count) > 0)
  if (stale.length > 0) {
    throw new Error(
      `Retention inventory is stale or missing: ${stale.map(([label, count]) => `${label}=${count}`).join(", ")}`,
    )
  }
}

async function activeRates(db: Kysely<DB>, dimensions: string[], at: Date) {
  const book = await db
    .selectFrom("priceBook")
    .select("id")
    .where("effectiveAt", "<=", at)
    .orderBy("effectiveAt", "desc")
    .orderBy("version", "desc")
    .executeTakeFirst()
  if (book === undefined) throw new Error("No active price book for retention reserve")
  const rows = await db
    .selectFrom("priceBookItem")
    .select(["dimension", "unitMicroUsd"])
    .where("priceBookId", "=", book.id)
    .where("dimension", "in", dimensions)
    .execute()
  return new Map(rows.map((row) => [row.dimension, String(row.unitMicroUsd)]))
}

async function recentStorageReserve(db: Kysely<DB>, organizationId: string, at: Date) {
  const dimensions = [
    "db_storage_gib_hour",
    "db_storage_gb_month",
    "db_history_storage_gb_month",
    "es_storage_gib_hour",
    "site_gib_second",
    "site_provisioned_gib_second",
  ]
  const since = new Date(at.getTime() - 2 * 86_400_000)
  const rows = await db
    .selectFrom("usageRollup")
    .select(["dimension", sql<string>`sum(quantity)::text`.as("quantity")])
    .where("organizationId", "=", organizationId)
    .where("bucket", "=", "day")
    .where("bucketStart", ">=", since)
    .where("bucketStart", "<", at)
    .where("dimension", "in", dimensions)
    .groupBy("dimension")
    .execute()
  const rates = await activeRates(db, dimensions, at)
  let total = 0n
  for (const row of rows) {
    total += rateTimesQuantity(rates.get(row.dimension) ?? "0", row.quantity)
  }
  return total
}

/** The protected balance floor for two more days of the latest measured mutable S3 bytes. */
export async function protectedObjectStorageReserve(
  db: Kysely<DB>,
  organizationId: string,
  at: Date = new Date(),
): Promise<bigint> {
  const stored = await db
    .selectFrom("objectStorageMeteringState")
    .innerJoin("backendService", "backendService.id", "objectStorageMeteringState.backendServiceId")
    .select(
      sql<string>`coalesce(sum(object_storage_metering_state.current_bytes), 0)::text`.as("bytes"),
    )
    .where("backendService.organizationId", "=", organizationId)
    .where("backendService.deletedAt", "is", null)
    .executeTakeFirstOrThrow()
  const bytes = BigInt(stored.bytes)
  if (bytes === 0n) return 0n

  const item = await db
    .selectFrom("priceBook")
    .innerJoin("priceBookItem", "priceBookItem.priceBookId", "priceBook.id")
    .select("priceBookItem.unitMicroUsd")
    .where("priceBook.effectiveAt", "<=", at)
    .where("priceBookItem.dimension", "=", "object_storage_gb_month")
    .orderBy("priceBook.effectiveAt", "desc")
    .orderBy("priceBook.version", "desc")
    .executeTakeFirst()
  if (item === undefined) {
    throw new Error("The active price book does not price object-storage retention")
  }
  const rate = item.unitMicroUsd
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate)
  if (match === null) throw new Error(`Invalid object-storage retention rate: ${rate}`)
  // A fractional micro-dollar rate is rounded upward for the reserve only. Actual billing retains
  // its numeric precision; under-reserving by a fraction would break the guarantee this floor makes.
  const roundedRate = BigInt(match[1]) + (/[1-9]/.test(match[2] ?? "") ? 1n : 0n)
  return objectStorageReserveMicroUsd(bytes, roundedRate, at)
}
