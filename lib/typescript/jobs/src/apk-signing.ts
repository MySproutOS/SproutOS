import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { v7 } from "uuid"

export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000
export const APK_MIME = "application/vnd.android.package-archive"

export function packageNameForProject(projectId: string): string {
  return `me.sproutos.app.p${projectId.replaceAll("-", "")}`
}

type JobDb = Kysely<DB> | Transaction<DB>
export type SigningJob =
  | { id: string; kind: "provision_key"; androidAppId: string; packageName: string }
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

export async function ensureAndroidSetup(db: Kysely<DB>, projectId: string) {
  return await db.transaction().execute(async (trx) => {
    const app = await ensureApp(trx, projectId)
    if (app.keyObjectKey === null) {
      await trx
        .insertInto("androidSignerJob")
        .values({ id: v7(), androidAppId: app.id, kind: "provision_key", state: "queued" })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    return app
  })
}

export async function androidVersionError(
  db: Kysely<DB>,
  projectId: string,
  versionCode: number,
): Promise<string | undefined> {
  const latest = await db
    .selectFrom("androidApp")
    .leftJoin("androidSignerJob", "androidSignerJob.androidAppId", "androidApp.id")
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
    const app = await ensureApp(trx, input.projectId)
    if (app.keyObjectKey === null) {
      await trx
        .insertInto("androidSignerJob")
        .values({ id: v7(), androidAppId: app.id, kind: "provision_key", state: "queued" })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    if (input.versionCode <= app.lastAcceptedVersionCode) {
      throw new Error(
        `Android versionCode ${input.versionCode} must exceed ${app.lastAcceptedVersionCode}`,
      )
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
      .onConflict((oc) => oc.doNothing())
      .execute()
    return (
      await trx
        .selectFrom("androidSignerJob")
        .select("id")
        .where("deploymentId", "=", input.deploymentId)
        .executeTakeFirstOrThrow()
    ).id
  })
}

export async function claimSigningJob(
  db: Kysely<DB>,
  signerId: string,
  now: () => Date = () => new Date(),
): Promise<SigningJob | undefined> {
  const claimedAt = now()
  const staleBefore = new Date(claimedAt.getTime() - CLAIM_TIMEOUT_MS)
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
    .set({ state: "running", claimedBy: signerId, claimedAt, updatedAt: claimedAt })
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
  }
}

export async function completeKeyProvision(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    keyObjectKey: string
    keyObjectVersion: string
    certificateSha256: string
    developerConsoleState: "pending_registration" | "registered"
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom("androidSignerJob")
      .select("androidAppId")
      .where("id", "=", input.jobId)
      .where("kind", "=", "provision_key")
      .where("state", "=", "running")
      .where("claimedBy", "=", input.signerId)
      .forUpdate()
      .executeTakeFirst()
    if (
      held === undefined ||
      input.keyObjectKey !== `keys/${held.androidAppId}/signing.keystore.enc`
    ) {
      return false
    }
    const job = await trx
      .updateTable("androidSignerJob")
      .set({ state: "succeeded", signedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", input.jobId)
      .where("kind", "=", "provision_key")
      .where("state", "=", "running")
      .where("claimedBy", "=", input.signerId)
      .returning("androidAppId")
      .executeTakeFirst()
    if (job === undefined) return false
    await trx
      .updateTable("androidApp")
      .set({
        keyObjectKey: input.keyObjectKey,
        keyObjectVersion: input.keyObjectVersion,
        certificateSha256: input.certificateSha256,
        developerConsoleState: input.developerConsoleState,
        developerConsoleError: null,
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
    signedKey: string
    signedObjectVersion: string
    signedDigest: string
    signedSizeBytes: bigint
    packageName: string
    versionCode: number
    versionName: string
    certificateSha256: string
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
        "androidApp.packageName",
        "androidApp.certificateSha256",
        "androidApp.lastAcceptedVersionCode",
      ])
      .where("androidSignerJob.id", "=", input.jobId)
      .where("androidSignerJob.kind", "=", "sign_release")
      .where("androidSignerJob.state", "=", "running")
      .where("androidSignerJob.claimedBy", "=", input.signerId)
      .forUpdate()
      .executeTakeFirst()
    if (
      job === undefined ||
      job.deploymentId === null ||
      job.versionCode !== input.versionCode ||
      job.packageName !== input.packageName ||
      job.certificateSha256 !== input.certificateSha256 ||
      input.versionCode <= job.lastAcceptedVersionCode ||
      input.signedKey !== `signed/${job.androidAppId}/${input.jobId}.apk`
    )
      return false

    await trx
      .updateTable("androidSignerJob")
      .set({
        state: "succeeded",
        signedKey: input.signedKey,
        signedObjectVersion: input.signedObjectVersion,
        signedDigest: input.signedDigest,
        signedSizeBytes: input.signedSizeBytes,
        versionName: input.versionName,
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
        lastError: null,
        updatedAt: new Date(),
      })
      .where("id", "=", job.androidAppId)
      .execute()
    await trx
      .updateTable("deployment")
      .set({ status: "ready", failureReason: null, updatedAt: new Date() })
      .where("id", "=", job.deploymentId)
      .execute()
    return true
  })
}

export async function failSigning(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    error: string
    developerConsoleState?: "ownership_required" | "failed"
    maxAttempts?: number
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("androidSignerJob")
      .select(["androidAppId", "attempts", "deploymentId", "kind"])
      .where("id", "=", input.jobId)
      .where("state", "=", "running")
      .where("claimedBy", "=", input.signerId)
      .forUpdate()
      .executeTakeFirst()
    if (job === undefined) return false
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
