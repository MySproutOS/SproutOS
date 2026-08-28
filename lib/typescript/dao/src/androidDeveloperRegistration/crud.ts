import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { v7 } from "uuid"

export type AndroidRegistrationProviderState =
  | "NOT_REGISTERED"
  | "REGISTERED"
  | "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"

type RegistrationDb = Kysely<DB> | Transaction<DB>

export async function promoteReadyAndroidDeployments(
  db: RegistrationDb,
  projectId: string,
  now: Date,
): Promise<number> {
  const result = await sql`
    update deployment
    set status = 'ready', failure_reason = null, updated_at = ${now}
    from apk_signing_job, android_developer_registration
    where apk_signing_job.deployment_id = deployment.id
      and apk_signing_job.project_id = ${projectId}
      and apk_signing_job.status = 'signed'
      and android_developer_registration.project_id = ${projectId}
      and android_developer_registration.state = 'registered'
      and android_developer_registration.provider_state = 'REGISTERED'
      and android_developer_registration.verified_setup_commit is not null
      and deployment.status = 'queued'
  `.execute(db)
  return Number(result.numAffectedRows ?? 0n)
}

export function crudAndroidDeveloperRegistration(db: Kysely<DB>) {
  async function ensure(input: {
    projectId: string
    packageName: string
    certificateSha256: string
  }) {
    return await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("androidDeveloperRegistration")
        .values({
          id: v7(),
          projectId: input.projectId,
          packageName: input.packageName,
          certificateSha256: input.certificateSha256,
        })
        .onConflict((oc) => oc.column("projectId").doNothing())
        .execute()
      const registration = await trx
        .selectFrom("androidDeveloperRegistration")
        .selectAll()
        .where("projectId", "=", input.projectId)
        .executeTakeFirstOrThrow()
      if (
        registration.packageName !== input.packageName ||
        registration.certificateSha256 !== input.certificateSha256
      ) {
        throw new Error("Android package name and signing certificate are immutable per project")
      }
      return registration
    })
  }

  async function verifySetupCommit(projectId: string, commit: string): Promise<boolean> {
    return await db.transaction().execute(async (trx) => {
      const now = new Date()
      const updated = await trx
        .updateTable("androidDeveloperRegistration")
        .set({ verifiedSetupCommit: commit, updatedAt: now })
        .where("projectId", "=", projectId)
        .returning("id")
        .executeTakeFirst()
      if (updated === undefined) return false
      await promoteReadyAndroidDeployments(trx, projectId, now)
      return true
    })
  }

  async function claimDue(
    workerId: string,
    input: { now: Date; staleBefore: Date; limit: number },
  ) {
    return await db
      .with("candidate", (qb) =>
        qb
          .selectFrom("androidDeveloperRegistration")
          .select("id")
          .where("state", "!=", "registered")
          .where("nextCheckAt", "<=", input.now)
          .where((eb) =>
            eb.or([eb("claimedAt", "is", null), eb("claimedAt", "<", input.staleBefore)]),
          )
          .orderBy("nextCheckAt")
          .limit(input.limit)
          .forUpdate()
          .skipLocked(),
      )
      .updateTable("androidDeveloperRegistration")
      .from("candidate")
      .set({ claimedBy: workerId, claimedAt: input.now, updatedAt: input.now })
      .whereRef("androidDeveloperRegistration.id", "=", "candidate.id")
      .returning([
        "androidDeveloperRegistration.id",
        "androidDeveloperRegistration.projectId",
        "androidDeveloperRegistration.packageName",
        "androidDeveloperRegistration.certificateSha256",
        "androidDeveloperRegistration.checkAttempts",
      ])
      .execute()
  }

  async function recordProviderState(input: {
    id: string
    workerId: string
    providerState: AndroidRegistrationProviderState
    checkedAt: Date
    nextCheckAt: Date
    failure?: string
  }): Promise<boolean> {
    return await db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("androidDeveloperRegistration")
        .set({
          providerState: input.providerState,
          state:
            input.providerState === "REGISTERED"
              ? "registered"
              : input.providerState === "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
                ? "failed"
                : "pending_registration",
          checkAttempts: sql`check_attempts + 1`,
          lastCheckedAt: input.checkedAt,
          nextCheckAt: input.nextCheckAt,
          lastFailure: input.failure ?? null,
          claimedBy: null,
          claimedAt: null,
          updatedAt: input.checkedAt,
        })
        .where("id", "=", input.id)
        .where("claimedBy", "=", input.workerId)
        .returning("projectId")
        .executeTakeFirst()
      if (updated === undefined) return false
      if (input.providerState === "REGISTERED") {
        await promoteReadyAndroidDeployments(trx, updated.projectId, input.checkedAt)
      }
      return true
    })
  }

  async function recordCheckFailure(input: {
    id: string
    workerId: string
    checkedAt: Date
    nextCheckAt: Date
    failure: string
  }): Promise<boolean> {
    const updated = await db
      .updateTable("androidDeveloperRegistration")
      .set({
        state: "failed",
        checkAttempts: sql`check_attempts + 1`,
        lastCheckedAt: input.checkedAt,
        nextCheckAt: input.nextCheckAt,
        lastFailure: input.failure.slice(0, 2000),
        claimedBy: null,
        claimedAt: null,
        updatedAt: input.checkedAt,
      })
      .where("id", "=", input.id)
      .where("claimedBy", "=", input.workerId)
      .returning("id")
      .executeTakeFirst()
    return updated !== undefined
  }

  async function reconcilerSeen(now: Date): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ lastSeenAt: now, updatedAt: now })
      .where("id", "=", "developer-id-status")
      .execute()
  }

  async function reconcilerCompleted(now: Date): Promise<void> {
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ lastCompletedAt: now, lastFailure: null, updatedAt: now })
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

  return {
    claimDue,
    ensure,
    reconcilerCompleted,
    reconcilerFailed,
    reconcilerSeen,
    recordCheckFailure,
    recordProviderState,
    verifySetupCommit,
  }
}
