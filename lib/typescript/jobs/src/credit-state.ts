import { availableBalance } from "@lib/billing"
import { clearCreditState, publishCreditState } from "@lib/lambda"
import { Redis } from "ioredis"
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import type { JobHandler } from "./worker"
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
    const reserve = await protectedObjectStorageReserve(trx, organizationId)
    const now = new Date()
    const exhausted = balance <= reserve

    await trx
      .insertInto("creditRetentionState")
      .values({
        organizationId,
        reserveMicroUsd: reserve,
        exhaustedAt: exhausted ? now : null,
        deleteAfter: exhausted
          ? new Date(now.getTime() + OBJECT_STORAGE_RETENTION_SECONDS * 1000)
          : null,
      })
      .onConflict((conflict) =>
        conflict.column("organizationId").doUpdateSet(
          exhausted
            ? {
                reserveMicroUsd: reserve,
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
                exhaustedAt: null,
                deleteAfter: null,
                updatedAt: now,
              },
        ),
      )
      .execute()
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
