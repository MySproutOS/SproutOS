import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { randomBytes } from "node:crypto"
import { v7 } from "uuid"

// A signer performs bounded downloads plus several bounded Android-tool invocations. Keep the
// lease longer than their combined worst case so a valid slow job cannot be stolen mid-signing.
export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000
export const APK_MIME = "application/vnd.android.package-archive"
export const ANDROID_VERSION_CODE_MAX = 2_100_000_000

export type DeveloperConsoleState =
  | "pending"
  | "pending_registration"
  | "registering"
  | "ownership_required"
  | "registered"
  | "failed"

export type AndroidRegistrationProviderState =
  | "NOT_REGISTERED"
  | "REGISTERED"
  | "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"

export function packageNameForProject(projectId: string): string {
  return `me.sproutos.app.p${projectId.replaceAll("-", "")}`
}

type JobDb = Kysely<DB> | Transaction<DB>
export type SigningJob =
  | {
      id: string
      kind: "provision_key"
      androidAppId: string
      packageName: string
      claimToken: string
    }
  | {
      id: string
      kind: "sign_release"
      androidAppId: string
      packageName: string
      projectId: string
      deploymentId: string
      unsignedKey: string
      unsignedDigest: string
      versionCode: number
      previousVersionCode: number
      certificateSha256: string
      keyObjectKey: string
      keyObjectVersion: string
      claimToken: string
    }

async function ensureApp(db: JobDb, projectId: string) {
  const found = await db
    .selectFrom("androidApp")
    .selectAll()
    .where("projectId", "=", projectId)
    .executeTakeFirst()
  if (found !== undefined) return found
  await db
    .insertInto("androidApp")
    .values({ id: v7(), projectId, packageName: packageNameForProject(projectId) })
    .onConflict((oc) => oc.column("projectId").doNothing())
    .execute()
  return await db
    .selectFrom("androidApp")
    .selectAll()
    .where("projectId", "=", projectId)
    .executeTakeFirstOrThrow()
}

async function ensureProvisionJob(db: JobDb, androidAppId: string): Promise<void> {
  await db
    .insertInto("androidSignerJob")
    .values({ id: v7(), androidAppId, kind: "provision_key", state: "queued" })
    .onConflict((oc) => oc.doNothing())
    .execute()
  // The per-app identity must remain unique, so recovery reuses the one normalized provision job
  // instead of creating a second key identity. A new setup/deploy request is the explicit retry.
  const retried = await db
    .updateTable("androidSignerJob")
    .set({
      state: "queued",
      attempts: 0,
      error: null,
      claimedBy: null,
      claimedAt: null,
      claimToken: null,
      callbackIdempotencyKey: null,
      callbackClaimToken: null,
      updatedAt: new Date(),
    })
    .where("androidAppId", "=", androidAppId)
    .where("kind", "=", "provision_key")
    .where("state", "=", "failed")
    .executeTakeFirst()
  if (retried.numUpdatedRows > 0n) {
    await db
      .updateTable("androidApp")
      .set({
        developerConsoleState: "pending",
        developerConsoleError: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where("id", "=", androidAppId)
      .execute()
  }
}

/**
 * Make the newest signed release visible only after both independent setup proofs exist.
 *
 * Signing, developer registration, and setup-commit verification can finish in any order. Keeping
 * the convergence in this module gives each lane one narrow state update while preserving a single
 * publication gate.
 */
async function reconcileLatestReleaseVisibility(db: JobDb, androidAppId: string): Promise<void> {
  const app = await db
    .selectFrom("androidApp")
    .select(["developerConsoleState", "verifiedSetupCommit", "latestGoodDeploymentId"])
    .where("id", "=", androidAppId)
    .executeTakeFirst()
  if (app?.latestGoodDeploymentId === null || app?.latestGoodDeploymentId === undefined) return

  if (app.developerConsoleState !== "registered" || app.verifiedSetupCommit === null) {
    await db
      .updateTable("deployment")
      .set({ status: "queued", updatedAt: new Date() })
      .where("id", "=", app.latestGoodDeploymentId)
      .where("status", "=", "ready")
      .execute()
    return
  }

  await db
    .updateTable("deployment")
    .set({ status: "ready", failureReason: null, updatedAt: new Date() })
    .where("id", "=", app.latestGoodDeploymentId)
    .where("status", "=", "queued")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("androidSignerJob")
          .select("androidSignerJob.id")
          .whereRef("androidSignerJob.deploymentId", "=", "deployment.id")
          .where("androidSignerJob.kind", "=", "sign_release")
          .where("androidSignerJob.state", "=", "succeeded"),
      ),
    )
    .execute()
}

/** The registration reconciler's only write boundary into Android app state. */
export async function recordDeveloperConsoleState(
  db: Kysely<DB>,
  input: {
    androidAppId: string
    state: DeveloperConsoleState
    error?: string | null
    claimToken?: string
    providerState?: AndroidRegistrationProviderState
    checkedAt?: Date
    nextCheckAt?: Date
  },
): Promise<boolean> {
  if (
    input.state === "registered" &&
    (input.providerState !== "REGISTERED" || input.claimToken === undefined)
  )
    return false
  const now = input.checkedAt ?? new Date()
  return await db.transaction().execute(async (trx) => {
    let update = trx
      .updateTable("androidApp")
      .set({
        developerConsoleState: input.state,
        developerConsoleError: input.error?.slice(0, 2000) ?? null,
        ...(input.providerState === undefined
          ? {}
          : {
              developerConsoleProviderState: input.providerState,
              developerConsoleCheckAttempts: sql`developer_console_check_attempts + 1`,
              developerConsoleLastCheckedAt: now,
              developerConsoleNextCheckAt: input.nextCheckAt ?? now,
              developerConsoleLastFailure: input.error?.slice(0, 2000) ?? null,
              developerConsoleClaimToken: null,
              developerConsoleClaimExpiresAt: null,
            }),
        updatedAt: now,
      })
      .where("id", "=", input.androidAppId)
      // Registration without an immutable key identity would be a state-machine fabrication.
      .where("certificateSha256", "is not", null)
    if (input.claimToken !== undefined) {
      update = update.where("developerConsoleClaimToken", "=", input.claimToken)
    }
    if (input.state === "registered") {
      update = update.where("developerConsoleAccount", "is not", null)
    }
    const updated = await update.returning("id").executeTakeFirst()
    if (updated === undefined) return false
    await reconcileLatestReleaseVisibility(trx, input.androidAppId)
    return true
  })
}

/** Record a provider transport/API failure without fabricating a registration-state transition. */
export async function recordDeveloperConsoleCheckFailure(
  db: Kysely<DB>,
  input: {
    androidAppId: string
    claimToken: string
    checkedAt: Date
    nextCheckAt: Date
    error: string
  },
): Promise<boolean> {
  const updated = await db
    .updateTable("androidApp")
    .set({
      developerConsoleCheckAttempts: sql`developer_console_check_attempts + 1`,
      developerConsoleLastCheckedAt: input.checkedAt,
      developerConsoleNextCheckAt: input.nextCheckAt,
      developerConsoleLastFailure: input.error.slice(0, 2000),
      developerConsoleClaimToken: null,
      developerConsoleClaimExpiresAt: null,
      updatedAt: input.checkedAt,
    })
    .where("id", "=", input.androidAppId)
    .where("developerConsoleClaimToken", "=", input.claimToken)
    .returning("id")
    .executeTakeFirst()
  return updated !== undefined
}

/** Record the verified repository setup and converge publication if registration already won. */
export async function recordVerifiedSetupCommit(
  db: Kysely<DB>,
  androidAppId: string,
  commit: string,
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("androidApp")
      .set({ verifiedSetupCommit: commit, updatedAt: new Date() })
      .where("id", "=", androidAppId)
      .returning("id")
      .executeTakeFirst()
    if (updated === undefined) return false
    await reconcileLatestReleaseVisibility(trx, androidAppId)
    return true
  })
}

export async function ensureAndroidSetup(db: Kysely<DB>, projectId: string) {
  return await db.transaction().execute(async (trx) => {
    const app = await ensureApp(trx, projectId)
    if (app.keyObjectKey === null) {
      await ensureProvisionJob(trx, app.id)
    }
    return app
  })
}

export async function androidVersionError(
  db: Kysely<DB>,
  projectId: string,
  versionCode: number,
): Promise<string | undefined> {
  if (versionCode > ANDROID_VERSION_CODE_MAX) {
    return `Android versionCode ${versionCode} must not exceed ${ANDROID_VERSION_CODE_MAX}`
  }
  const latest = await db
    .selectFrom("androidApp")
    .leftJoin("androidSignerJob", (join) =>
      join
        .onRef("androidSignerJob.androidAppId", "=", "androidApp.id")
        .on("androidSignerJob.state", "!=", "failed"),
    )
    .select((eb) => [
      "androidApp.lastAcceptedVersionCode",
      eb.fn.max("androidSignerJob.versionCode").as("latestQueuedVersionCode"),
    ])
    .where("androidApp.projectId", "=", projectId)
    .groupBy("androidApp.lastAcceptedVersionCode")
    .executeTakeFirst()
  const latestVersion = Math.max(
    latest?.lastAcceptedVersionCode ?? 0,
    latest?.latestQueuedVersionCode ?? 0,
  )
  return versionCode > latestVersion
    ? undefined
    : `Android versionCode ${versionCode} must exceed ${latestVersion}`
}

export async function enqueueSigning(
  db: Kysely<DB>,
  input: {
    deploymentId: string
    projectId: string
    unsignedKey: string
    unsignedDigest: string
    versionCode: number
  },
): Promise<string> {
  return await db.transaction().execute(async (trx) => {
    if (input.versionCode < 1 || input.versionCode > ANDROID_VERSION_CODE_MAX) {
      throw new Error(
        `Android versionCode ${input.versionCode} must be between 1 and ${ANDROID_VERSION_CODE_MAX}`,
      )
    }
    await ensureApp(trx, input.projectId)
    const app = await trx
      .selectFrom("androidApp")
      .selectAll()
      .where("projectId", "=", input.projectId)
      .forUpdate()
      .executeTakeFirstOrThrow()
    if (app.keyObjectKey === null) {
      await ensureProvisionJob(trx, app.id)
    }
    const active = await trx
      .selectFrom("androidSignerJob")
      .select((eb) => eb.fn.max("versionCode").as("latestVersionCode"))
      .where("androidAppId", "=", app.id)
      .where("kind", "=", "sign_release")
      .where("state", "!=", "failed")
      .executeTakeFirst()
    const latestVersionCode = Math.max(app.lastAcceptedVersionCode, active?.latestVersionCode ?? 0)
    if (input.versionCode <= latestVersionCode) {
      throw new Error(`Android versionCode ${input.versionCode} must exceed ${latestVersionCode}`)
    }
    await trx
      .insertInto("androidSignerJob")
      .values({
        id: v7(),
        androidAppId: app.id,
        kind: "sign_release",
        state: "queued",
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        unsignedKey: input.unsignedKey,
        unsignedDigest: input.unsignedDigest,
        inputMime: APK_MIME,
        versionCode: input.versionCode,
      })
      .onConflict((oc) =>
        oc
          .column("deploymentId")
          .where("kind", "=", "sign_release")
          .where("state", "!=", "failed")
          .doNothing(),
      )
      .execute()
    return (
      await trx
        .selectFrom("androidSignerJob")
        .select("id")
        .where("deploymentId", "=", input.deploymentId)
        .where("state", "!=", "failed")
        .executeTakeFirstOrThrow()
    ).id
  })
}

export async function claimSigningJob(
  db: Kysely<DB>,
  signerId: string,
  now: () => Date = () => new Date(),
  token: () => string = () => randomBytes(32).toString("hex"),
): Promise<SigningJob | undefined> {
  const claimedAt = now()
  const staleBefore = new Date(claimedAt.getTime() - CLAIM_TIMEOUT_MS)
  const claimToken = token()
  const claim = await db
    .with("candidate", (qb) =>
      qb
        .selectFrom("androidSignerJob")
        .innerJoin("androidApp", "androidApp.id", "androidSignerJob.androidAppId")
        .select("androidSignerJob.id")
        .where((eb) =>
          eb.or([
            eb("androidSignerJob.state", "=", "queued"),
            eb.and([
              eb("androidSignerJob.state", "=", "running"),
              eb("androidSignerJob.claimedAt", "<", staleBefore),
            ]),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb("androidSignerJob.kind", "=", "provision_key"),
            eb.and([
              eb("androidSignerJob.kind", "=", "sign_release"),
              eb("androidApp.keyObjectKey", "is not", null),
              eb("androidApp.keyObjectVersion", "is not", null),
              eb("androidApp.certificateSha256", "is not", null),
            ]),
          ]),
        )
        .orderBy(sql`case when android_signer_job.kind = 'provision_key' then 0 else 1 end`)
        .orderBy("androidSignerJob.createdAt")
        .limit(1)
        .forUpdate()
        .skipLocked(),
    )
    .updateTable("androidSignerJob")
    .from("candidate")
    .set({
      state: "running",
      claimedBy: signerId,
      claimedAt,
      claimToken,
      updatedAt: claimedAt,
    })
    .whereRef("androidSignerJob.id", "=", "candidate.id")
    .returning("androidSignerJob.id")
    .executeTakeFirst()
  if (claim === undefined) return undefined

  const row = await db
    .selectFrom("androidSignerJob")
    .innerJoin("androidApp", "androidApp.id", "androidSignerJob.androidAppId")
    .select([
      "androidSignerJob.id",
      "androidSignerJob.kind",
      "androidSignerJob.androidAppId",
      "androidSignerJob.projectId",
      "androidSignerJob.deploymentId",
      "androidSignerJob.unsignedKey",
      "androidSignerJob.unsignedDigest",
      "androidSignerJob.versionCode",
      "androidApp.packageName",
      "androidApp.lastAcceptedVersionCode as previousVersionCode",
      "androidApp.certificateSha256",
      "androidApp.keyObjectKey",
      "androidApp.keyObjectVersion",
    ])
    .where("androidSignerJob.id", "=", claim.id)
    .executeTakeFirstOrThrow()
  if (row.kind === "provision_key") {
    return {
      id: row.id,
      kind: "provision_key",
      androidAppId: row.androidAppId,
      packageName: row.packageName,
      claimToken,
    }
  }
  if (
    row.projectId === null ||
    row.deploymentId === null ||
    row.unsignedKey === null ||
    row.unsignedDigest === null ||
    row.versionCode === null ||
    row.certificateSha256 === null ||
    row.keyObjectKey === null ||
    row.keyObjectVersion === null
  )
    throw new Error(`Android signing job ${row.id} is incomplete`)
  return {
    id: row.id,
    kind: "sign_release",
    androidAppId: row.androidAppId,
    packageName: row.packageName,
    projectId: row.projectId,
    deploymentId: row.deploymentId,
    unsignedKey: row.unsignedKey,
    unsignedDigest: row.unsignedDigest,
    versionCode: row.versionCode,
    previousVersionCode: row.previousVersionCode,
    certificateSha256: row.certificateSha256,
    keyObjectKey: row.keyObjectKey,
    keyObjectVersion: row.keyObjectVersion,
    claimToken,
  }
}

export async function completeKeyProvision(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    claimToken: string
    keyObjectKey: string
    keyObjectVersion: string
    certificateSha256: string
    developerConsoleState: "pending_registration"
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom("androidSignerJob")
      .select(["androidAppId", "callbackIdempotencyKey", "callbackClaimToken"])
      .where("id", "=", input.jobId)
      .where("kind", "=", "provision_key")
      .forUpdate()
      .executeTakeFirst()
    if (held?.callbackIdempotencyKey === input.idempotencyKey)
      return held.callbackClaimToken === input.claimToken
    if (
      held === undefined ||
      input.keyObjectKey !== `keys/${held.androidAppId}/signing.keystore.enc`
    ) {
      return false
    }
    const job = await trx
      .updateTable("androidSignerJob")
      .set({
        state: "succeeded",
        claimToken: null,
        callbackIdempotencyKey: input.idempotencyKey,
        callbackClaimToken: input.claimToken,
        signedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", input.jobId)
      .where("kind", "=", "provision_key")
      .where("state", "=", "running")
      .where("claimedBy", "=", input.signerId)
      .where("claimToken", "=", input.claimToken)
      .returning("androidAppId")
      .executeTakeFirst()
    if (job === undefined) return false
    await trx
      .updateTable("androidApp")
      .set({
        keyObjectKey: input.keyObjectKey,
        keyObjectVersion: input.keyObjectVersion,
        certificateSha256: input.certificateSha256,
        developerConsoleState: "pending_registration",
        developerConsoleError: null,
        developerConsoleProviderState: null,
        developerConsoleCheckAttempts: 0,
        developerConsoleLastCheckedAt: null,
        developerConsoleNextCheckAt: new Date(),
        developerConsoleLastFailure: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where("id", "=", job.androidAppId)
      .execute()
    return true
  })
}

export async function completeSigning(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    claimToken: string
    signedKey: string
    signedObjectVersion: string
    signedDigest: string
    signedSizeBytes: bigint
    packageName: string
    versionCode: number
    versionName: string
    certificateSha256: string
    developerConsoleAccount: string
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("androidSignerJob")
      .innerJoin("androidApp", "androidApp.id", "androidSignerJob.androidAppId")
      .select([
        "androidSignerJob.androidAppId",
        "androidSignerJob.deploymentId",
        "androidSignerJob.versionCode",
        "androidSignerJob.state",
        "androidSignerJob.claimedBy",
        "androidSignerJob.claimToken",
        "androidSignerJob.callbackIdempotencyKey",
        "androidSignerJob.callbackClaimToken",
        "androidApp.packageName",
        "androidApp.certificateSha256",
        "androidApp.developerConsoleAccount",
        "androidApp.lastAcceptedVersionCode",
        "androidApp.developerConsoleState",
        "androidApp.verifiedSetupCommit",
      ])
      .where("androidSignerJob.id", "=", input.jobId)
      .where("androidSignerJob.kind", "=", "sign_release")
      .forUpdate()
      .executeTakeFirst()
    if (job?.callbackIdempotencyKey === input.idempotencyKey)
      return job.callbackClaimToken === input.claimToken
    if (
      job === undefined ||
      job.state !== "running" ||
      job.claimedBy !== input.signerId ||
      job.claimToken !== input.claimToken ||
      job.deploymentId === null ||
      job.versionCode !== input.versionCode ||
      job.packageName !== input.packageName ||
      job.certificateSha256 !== input.certificateSha256 ||
      (job.developerConsoleAccount !== null &&
        job.developerConsoleAccount !== input.developerConsoleAccount) ||
      input.versionCode <= job.lastAcceptedVersionCode ||
      input.signedKey !== `signed/${job.androidAppId}/${input.jobId}.apk`
    )
      return false

    await trx
      .updateTable("androidSignerJob")
      .set({
        state: "succeeded",
        claimToken: null,
        signedKey: input.signedKey,
        signedObjectVersion: input.signedObjectVersion,
        signedDigest: input.signedDigest,
        signedSizeBytes: input.signedSizeBytes,
        versionName: input.versionName,
        callbackIdempotencyKey: input.idempotencyKey,
        callbackClaimToken: input.claimToken,
        signedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", input.jobId)
      .execute()
    await trx
      .updateTable("androidApp")
      .set({
        lastAcceptedVersionCode: input.versionCode,
        latestGoodDeploymentId: job.deploymentId,
        developerConsoleAccount: input.developerConsoleAccount,
        lastError: null,
        updatedAt: new Date(),
      })
      .where("id", "=", job.androidAppId)
      .execute()
    await reconcileLatestReleaseVisibility(trx, job.androidAppId)
    return true
  })
}

export async function failSigning(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    claimToken: string
    error: string
    developerConsoleState?: "ownership_required" | "failed"
    maxAttempts?: number
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("androidSignerJob")
      .select([
        "androidAppId",
        "attempts",
        "deploymentId",
        "kind",
        "callbackIdempotencyKey",
        "callbackClaimToken",
      ])
      .where("id", "=", input.jobId)
      .forUpdate()
      .executeTakeFirst()
    if (job?.callbackIdempotencyKey === input.idempotencyKey)
      return job.callbackClaimToken === input.claimToken
    if (job === undefined) return false
    const held = await trx
      .selectFrom("androidSignerJob")
      .select("id")
      .where("id", "=", input.jobId)
      .where("state", "=", "running")
      .where("claimedBy", "=", input.signerId)
      .where("claimToken", "=", input.claimToken)
      .executeTakeFirst()
    if (held === undefined) return false
    const attempts = job.attempts + 1
    const terminal = attempts >= (input.maxAttempts ?? 3)
    await trx
      .updateTable("androidSignerJob")
      .set({
        state: terminal ? "failed" : "queued",
        attempts,
        error: input.error.slice(0, 2000),
        claimedBy: null,
        claimedAt: null,
        claimToken: null,
        callbackIdempotencyKey: input.idempotencyKey,
        callbackClaimToken: input.claimToken,
        updatedAt: new Date(),
      })
      .where("id", "=", input.jobId)
      .execute()
    if (terminal) {
      await trx
        .updateTable("androidApp")
        .set({
          lastError: input.error.slice(0, 2000),
          ...(job.kind === "provision_key"
            ? {
                developerConsoleState: input.developerConsoleState ?? "failed",
                developerConsoleError: input.error.slice(0, 2000),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where("id", "=", job.androidAppId)
        .execute()
      if (job.kind === "provision_key") {
        const blocked = await trx
          .selectFrom("androidSignerJob")
          .select("deploymentId")
          .where("androidAppId", "=", job.androidAppId)
          .where("kind", "=", "sign_release")
          .where("state", "=", "queued")
          .where("deploymentId", "is not", null)
          .execute()
        await trx
          .updateTable("androidSignerJob")
          .set({ state: "failed", error: input.error.slice(0, 2000), updatedAt: new Date() })
          .where("androidAppId", "=", job.androidAppId)
          .where("kind", "=", "sign_release")
          .where("state", "=", "queued")
          .execute()
        const deploymentIds = blocked
          .map((row) => row.deploymentId)
          .filter((id): id is string => id !== null)
        if (deploymentIds.length > 0) {
          await trx
            .updateTable("deployment")
            .set({
              status: "error",
              failureReason: input.error.slice(0, 2000),
              updatedAt: new Date(),
            })
            .where("id", "in", deploymentIds)
            .execute()
        }
      }
      if (job.deploymentId !== null)
        await trx
          .updateTable("deployment")
          .set({
            status: "error",
            failureReason: input.error.slice(0, 2000),
            updatedAt: new Date(),
          })
          .where("id", "=", job.deploymentId)
          .execute()
    }
    return true
  })
}
