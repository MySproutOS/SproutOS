import type { DB } from "@sproutos/db"
import { sql, type Insertable, type Kysely, type Selectable, type Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudAndroidApp(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["androidApp"]>, "id">,
  ): Promise<Selectable<DB["androidApp"]>> {
    return await db
      .insertInto("androidApp")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    data: Updateable<DB["androidApp"]>,
  ): Promise<Selectable<DB["androidApp"]> | undefined> {
    return await db
      .updateTable("androidApp")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  async function claimDueRegistrations(input: {
    claimToken: string
    now: Date
    claimExpiresAt: Date
    limit: number
    dailyLimit: number
    configFingerprint: string
    androidAppIds?: string[]
  }) {
    return await db.transaction().execute(async (trx) => {
      const budget = await trx
        .selectFrom("androidRegistrationReconcilerState")
        .select([
          "quotaProviderDate",
          "quotaReserved",
          "terminalBlockedAt",
          "terminalConfigFingerprint",
          sql<string>`(${input.now}::timestamptz at time zone 'America/Los_Angeles')::date::text`.as(
            "providerDate",
          ),
        ])
        .where("id", "=", "developer-id-status")
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (
        budget.terminalBlockedAt !== null &&
        budget.terminalConfigFingerprint === input.configFingerprint
      ) {
        return { circuitOpen: true, rows: [] }
      }
      if (budget.terminalBlockedAt !== null) {
        await trx
          .updateTable("androidRegistrationReconcilerState")
          .set({
            terminalBlockedAt: null,
            terminalFailureKind: null,
            terminalConfigFingerprint: null,
            updatedAt: input.now,
          })
          .where("id", "=", "developer-id-status")
          .execute()
      }
      const storedDate =
        budget.quotaProviderDate instanceof Date
          ? budget.quotaProviderDate.toISOString().slice(0, 10)
          : String(budget.quotaProviderDate)
      const alreadyReserved = storedDate === budget.providerDate ? budget.quotaReserved : 0
      const available = Math.max(0, input.dailyLimit - alreadyReserved)
      const limit = Math.min(input.limit, available)
      if (limit === 0) {
        if (storedDate !== budget.providerDate) {
          await trx
            .updateTable("androidRegistrationReconcilerState")
            .set({
              quotaProviderDate: sql`${budget.providerDate}::date`,
              quotaReserved: 0,
              updatedAt: input.now,
            })
            .where("id", "=", "developer-id-status")
            .execute()
        }
        return { circuitOpen: false, rows: [] }
      }

      const claimed = await trx
        .with("candidate", (qb) =>
          qb
            .selectFrom("androidApp")
            .select("id")
            .where("certificateSha256", "is not", null)
            .where((eb) =>
              input.androidAppIds === undefined
                ? eb.val(true)
                : eb("androidApp.id", "in", input.androidAppIds),
            )
            .where("developerConsoleAccount", "is not", null)
            .where("developerConsoleNextCheckAt", "<=", input.now)
            .where((eb) =>
              eb.or([
                eb("developerConsoleClaimExpiresAt", "is", null),
                eb("developerConsoleClaimExpiresAt", "<=", input.now),
              ]),
            )
            .orderBy("developerConsoleNextCheckAt")
            .limit(limit)
            .forUpdate()
            .skipLocked(),
        )
        .updateTable("androidApp")
        .from("candidate")
        .set({
          developerConsoleClaimToken: input.claimToken,
          developerConsoleClaimExpiresAt: input.claimExpiresAt,
          updatedAt: input.now,
        })
        .whereRef("androidApp.id", "=", "candidate.id")
        .returning([
          "androidApp.id",
          "androidApp.packageName",
          "androidApp.certificateSha256",
          "androidApp.developerConsoleCheckAttempts",
          "androidApp.developerConsoleState",
        ])
        .execute()

      await trx
        .updateTable("androidRegistrationReconcilerState")
        .set({
          quotaProviderDate: sql`${budget.providerDate}::date`,
          quotaReserved: alreadyReserved + claimed.length,
          updatedAt: input.now,
        })
        .where("id", "=", "developer-id-status")
        .execute()
      return { circuitOpen: false, rows: claimed }
    })
  }

  async function releaseRegistrationClaims(claimToken: string, now: Date): Promise<void> {
    await db
      .updateTable("androidApp")
      .set({
        developerConsoleClaimToken: null,
        developerConsoleClaimExpiresAt: null,
        updatedAt: now,
      })
      .where("developerConsoleClaimToken", "=", claimToken)
      .execute()
  }

  async function reconcilerSeen(now: Date): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ lastSeenAt: now, updatedAt: now })
      .where("id", "=", "developer-id-status")
      .execute()
  }

  async function reconcilerCompleted(
    now: Date,
    failure: string | null,
    clearFailure: boolean,
  ): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({
        lastCompletedAt: now,
        ...(failure !== null
          ? { lastFailure: failure.slice(0, 2000) }
          : clearFailure
            ? { lastFailure: null }
            : {}),
        updatedAt: now,
      })
      .where("id", "=", "developer-id-status")
      .execute()
  }

  async function reconcilerFailed(now: Date, failure: string): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ lastFailure: failure.slice(0, 2000), updatedAt: now })
      .where("id", "=", "developer-id-status")
      .execute()
  }

  async function reconcilerTerminalFailed(input: {
    now: Date
    failure: string
    failureKind: "invalid_argument" | "unauthenticated" | "permission_denied" | "provider_contract"
    configFingerprint: string
  }): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({
        lastFailure: input.failure.slice(0, 2000),
        terminalBlockedAt: input.now,
        terminalFailureKind: input.failureKind,
        terminalConfigFingerprint: input.configFingerprint,
        updatedAt: input.now,
      })
      .where("id", "=", "developer-id-status")
      .execute()
  }

  return {
    claimDueRegistrations,
    create,
    reconcilerCompleted,
    reconcilerFailed,
    reconcilerSeen,
    reconcilerTerminalFailed,
    releaseRegistrationClaims,
    update,
  }
}
