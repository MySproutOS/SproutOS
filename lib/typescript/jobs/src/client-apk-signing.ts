import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Transaction } from "kysely"
import { v7 } from "uuid"
import { ANDROID_VERSION_CODE_MAX, APK_MIME, CLAIM_TIMEOUT_MS } from "./apk-signing"
import type { AndroidRegistrationProviderState } from "./apk-signing"

export const CLIENT_PACKAGE_NAME = "com.sproutos.store"
export const CLIENT_KEY_OBJECT_KEY = "keys/client/signing.keystore.enc"

type JobDb = Kysely<DB> | Transaction<DB>

export class ClientSigningConflictError extends Error {}

export type ClientSigningJob =
  | {
      id: string
      kind: "provision_client_key"
      packageName: typeof CLIENT_PACKAGE_NAME
    }
  | {
      id: string
      kind: "sign_client_release"
      packageName: typeof CLIENT_PACKAGE_NAME
      unsignedKey: string
      unsignedObjectVersion: string
      unsignedDigest: string
      versionCode: number
      previousVersionCode: number
      certificateSha256: string
      keyObjectKey: string
      keyObjectVersion: string
    }

async function identityForUpdate(db: JobDb) {
  return await db
    .selectFrom("clientSigningIdentity")
    .selectAll()
    .where("packageName", "=", CLIENT_PACKAGE_NAME)
    .forUpdate()
    .executeTakeFirst()
}

async function createIdentity(db: JobDb) {
  await db
    .insertInto("clientSigningIdentity")
    .values({ id: v7(), packageName: CLIENT_PACKAGE_NAME })
    .onConflict((oc) => oc.column("packageName").doNothing())
    .execute()
  return await identityForUpdate(db)
}

export async function ensureClientSigningIdentity(db: Kysely<DB>, operatorSignerId: string) {
  return await db.transaction().execute(async (trx) => {
    const identity = (await identityForUpdate(trx)) ?? (await createIdentity(trx))
    if (identity === undefined) throw new Error("Failed to create the catalogue-client identity")
    if (identity.state !== "ready") {
      await trx
        .insertInto("clientSignerJob")
        .values({
          id: v7(),
          clientSigningIdentityId: identity.id,
          kind: "provision_client_key",
          state: "queued",
          operatorSignerId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      const provision = await trx
        .selectFrom("clientSignerJob")
        .select(["id", "state"])
        .where("clientSigningIdentityId", "=", identity.id)
        .where("kind", "=", "provision_client_key")
        .executeTakeFirstOrThrow()
      if (provision.state === "failed") {
        await trx
          .updateTable("clientSignerJob")
          .set({
            state: "queued",
            attempts: 0,
            error: null,
            claimedBy: null,
            claimedAt: null,
            callbackIdempotencyKey: null,
            callbackKind: null,
            callbackSignerId: null,
            operatorSignerId,
            updatedAt: new Date(),
          })
          .where("id", "=", provision.id)
          .execute()
        await trx
          .updateTable("clientSigningIdentity")
          .set({ state: "pending", lastError: null, updatedAt: new Date() })
          .where("id", "=", identity.id)
          .execute()
      }
    }
    return await trx
      .selectFrom("clientSigningIdentity")
      .select(["packageName", "state", "certificateSha256"])
      .select(["developerConsoleState", "developerConsoleProviderState", "developerConsoleError"])
      .select("developerConsoleAccount")
      .where("id", "=", identity.id)
      .executeTakeFirstOrThrow()
  })
}

export async function prepareClientRelease(
  db: Kysely<DB>,
  input: {
    operatorSignerId: string
    packageName: string
    unsignedDigest: string
    sizeBytes: bigint
    versionCode: number
  },
): Promise<{
  jobId: string
  unsignedKey: string
  state: "awaiting_upload" | "queued" | "running" | "succeeded"
}> {
  if (input.packageName !== CLIENT_PACKAGE_NAME)
    throw new ClientSigningConflictError("The catalogue-client package name is immutable")
  if (input.versionCode < 1 || input.versionCode > ANDROID_VERSION_CODE_MAX)
    throw new ClientSigningConflictError(
      `Android versionCode must be between 1 and ${ANDROID_VERSION_CODE_MAX}`,
    )
  if (input.sizeBytes < 1n)
    throw new ClientSigningConflictError("The unsigned APK must not be empty")

  return await db.transaction().execute(async (trx) => {
    const identity = await identityForUpdate(trx)
    if (
      identity === undefined ||
      identity.state !== "ready" ||
      identity.keyObjectKey === null ||
      identity.keyObjectVersion === null ||
      identity.certificateSha256 === null
    ) {
      throw new ClientSigningConflictError("The catalogue-client signing identity is not ready")
    }

    const existing = await trx
      .selectFrom("clientSignerJob")
      .select(["id", "state", "operatorSignerId", "unsignedDigest", "unsignedSizeBytes"])
      .where("clientSigningIdentityId", "=", identity.id)
      .where("kind", "=", "sign_client_release")
      .where("versionCode", "=", input.versionCode)
      .where("state", "!=", "failed")
      .executeTakeFirst()
    if (existing !== undefined) {
      if (
        existing.operatorSignerId === input.operatorSignerId &&
        existing.unsignedDigest === input.unsignedDigest &&
        existing.unsignedSizeBytes === String(input.sizeBytes) &&
        ["awaiting_upload", "queued", "running", "succeeded"].includes(existing.state)
      ) {
        return {
          jobId: existing.id,
          unsignedKey: `raw/client/${existing.id}.apk`,
          state: existing.state as "awaiting_upload" | "queued" | "running" | "succeeded",
        }
      }
      throw new ClientSigningConflictError("That catalogue-client version is already in progress")
    }

    const active = await trx
      .selectFrom("clientSignerJob")
      .select("versionCode")
      .where("clientSigningIdentityId", "=", identity.id)
      .where("kind", "=", "sign_client_release")
      .where("state", "in", ["awaiting_upload", "queued", "running"])
      .executeTakeFirst()
    if (active !== undefined) {
      throw new ClientSigningConflictError(
        `Catalogue-client version ${active.versionCode} must finish before another release is prepared`,
      )
    }

    const latest = await trx
      .selectFrom("clientRelease")
      .select("versionCode")
      .where("packageName", "=", CLIENT_PACKAGE_NAME)
      .orderBy("versionCode", "desc")
      .limit(1)
      .executeTakeFirst()
    if (input.versionCode <= (latest?.versionCode ?? 0))
      throw new ClientSigningConflictError(
        `Android versionCode ${input.versionCode} must exceed ${latest?.versionCode ?? 0}`,
      )

    const jobId = v7()
    const unsignedKey = `raw/client/${jobId}.apk`
    await trx
      .insertInto("clientSignerJob")
      .values({
        id: jobId,
        clientSigningIdentityId: identity.id,
        kind: "sign_client_release",
        state: "awaiting_upload",
        operatorSignerId: input.operatorSignerId,
        unsignedKey,
        unsignedDigest: input.unsignedDigest,
        unsignedSizeBytes: input.sizeBytes,
        inputMime: APK_MIME,
        versionCode: input.versionCode,
      })
      .execute()
    return { jobId, unsignedKey, state: "awaiting_upload" }
  })
}

export async function finalizeClientReleaseUpload(
  db: Kysely<DB>,
  input: {
    jobId: string
    operatorSignerId: string
    unsignedKey: string
    unsignedObjectVersion: string
    unsignedDigest: string
    sizeBytes: bigint
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("clientSignerJob")
      .select([
        "kind",
        "state",
        "operatorSignerId",
        "unsignedKey",
        "unsignedObjectVersion",
        "unsignedDigest",
        "unsignedSizeBytes",
        "uploadIdempotencyKey",
      ])
      .where("id", "=", input.jobId)
      .forUpdate()
      .executeTakeFirst()
    if (job?.uploadIdempotencyKey === input.idempotencyKey) {
      return (
        job.operatorSignerId === input.operatorSignerId &&
        job.unsignedKey === input.unsignedKey &&
        job.unsignedObjectVersion === input.unsignedObjectVersion &&
        job.unsignedDigest === input.unsignedDigest &&
        job.unsignedSizeBytes === String(input.sizeBytes)
      )
    }
    if (
      job === undefined ||
      job.kind !== "sign_client_release" ||
      job.state !== "awaiting_upload" ||
      job.operatorSignerId !== input.operatorSignerId ||
      job.unsignedKey !== input.unsignedKey ||
      job.unsignedDigest !== input.unsignedDigest ||
      job.unsignedSizeBytes !== String(input.sizeBytes)
    )
      return false
    await trx
      .updateTable("clientSignerJob")
      .set({
        state: "queued",
        unsignedObjectVersion: input.unsignedObjectVersion,
        uploadIdempotencyKey: input.idempotencyKey,
        updatedAt: new Date(),
      })
      .where("id", "=", input.jobId)
      .execute()
    return true
  })
}

export async function claimClientSigningJob(
  db: Kysely<DB>,
  signerId: string,
  now: () => Date = () => new Date(),
): Promise<ClientSigningJob | undefined> {
  const claimedAt = now()
  const staleBefore = new Date(claimedAt.getTime() - CLAIM_TIMEOUT_MS)
  return await db.transaction().execute(async (trx) => {
    // The singleton identity row is the fleet-wide claim mutex. Without this lock two signer
    // processes can claim adjacent versions concurrently and a later completion can permanently
    // supersede the earlier job.
    const identity = await trx
      .selectFrom("clientSigningIdentity")
      .select("id")
      .where("packageName", "=", CLIENT_PACKAGE_NAME)
      .forUpdate()
      .executeTakeFirst()
    if (identity === undefined) return undefined
    const active = await trx
      .selectFrom("clientSignerJob")
      .select("id")
      .where("clientSigningIdentityId", "=", identity.id)
      .where("state", "=", "running")
      .where("claimedAt", ">=", staleBefore)
      .executeTakeFirst()
    if (active !== undefined) return undefined

    const claim = await trx
      .with("candidate", (qb) =>
        qb
          .selectFrom("clientSignerJob")
          .innerJoin(
            "clientSigningIdentity",
            "clientSigningIdentity.id",
            "clientSignerJob.clientSigningIdentityId",
          )
          .select("clientSignerJob.id")
          .where((eb) =>
            eb.or([
              eb("clientSignerJob.state", "=", "queued"),
              eb.and([
                eb("clientSignerJob.state", "=", "running"),
                eb("clientSignerJob.claimedAt", "<", staleBefore),
              ]),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb("clientSignerJob.kind", "=", "provision_client_key"),
              eb.and([
                eb("clientSignerJob.kind", "=", "sign_client_release"),
                eb("clientSigningIdentity.state", "=", "ready"),
              ]),
            ]),
          )
          .orderBy(sql`case when client_signer_job.kind = 'provision_client_key' then 0 else 1 end`)
          .orderBy(sql`coalesce(client_signer_job.version_code, 0)`)
          .orderBy("clientSignerJob.createdAt")
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .updateTable("clientSignerJob")
      .from("candidate")
      .set({
        state: "running",
        claimedBy: signerId,
        claimedAt,
        callbackIdempotencyKey: null,
        callbackKind: null,
        callbackSignerId: null,
        updatedAt: claimedAt,
      })
      .whereRef("clientSignerJob.id", "=", "candidate.id")
      .returning("clientSignerJob.id")
      .executeTakeFirst()
    if (claim === undefined) return undefined
    const row = await trx
      .selectFrom("clientSignerJob")
      .innerJoin(
        "clientSigningIdentity",
        "clientSigningIdentity.id",
        "clientSignerJob.clientSigningIdentityId",
      )
      .select([
        "clientSignerJob.id",
        "clientSignerJob.kind",
        "clientSignerJob.clientSigningIdentityId",
        "clientSignerJob.unsignedKey",
        "clientSignerJob.unsignedObjectVersion",
        "clientSignerJob.unsignedDigest",
        "clientSignerJob.versionCode",
        "clientSigningIdentity.packageName",
        "clientSigningIdentity.certificateSha256",
        "clientSigningIdentity.keyObjectKey",
        "clientSigningIdentity.keyObjectVersion",
      ])
      .where("clientSignerJob.id", "=", claim.id)
      .executeTakeFirstOrThrow()
    if (row.kind === "provision_client_key") {
      await trx
        .updateTable("clientSigningIdentity")
        .set({ state: "provisioning", lastError: null, updatedAt: claimedAt })
        .where("id", "=", row.clientSigningIdentityId)
        .execute()
      return { id: row.id, kind: "provision_client_key", packageName: CLIENT_PACKAGE_NAME }
    }
    if (
      row.unsignedKey === null ||
      row.unsignedObjectVersion === null ||
      row.unsignedDigest === null ||
      row.versionCode === null ||
      row.certificateSha256 === null ||
      row.keyObjectKey === null ||
      row.keyObjectVersion === null
    )
      throw new Error(`Catalogue-client signing job ${row.id} is incomplete`)
    const latest = await trx
      .selectFrom("clientRelease")
      .select("versionCode")
      .where("packageName", "=", CLIENT_PACKAGE_NAME)
      .orderBy("versionCode", "desc")
      .limit(1)
      .executeTakeFirst()
    return {
      id: row.id,
      kind: "sign_client_release",
      packageName: CLIENT_PACKAGE_NAME,
      unsignedKey: row.unsignedKey,
      unsignedObjectVersion: row.unsignedObjectVersion,
      unsignedDigest: row.unsignedDigest,
      versionCode: row.versionCode,
      previousVersionCode: latest?.versionCode ?? 0,
      certificateSha256: row.certificateSha256,
      keyObjectKey: row.keyObjectKey,
      keyObjectVersion: row.keyObjectVersion,
    }
  })
}

export async function completeClientKeyProvision(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    keyObjectKey: string
    keyObjectVersion: string
    certificateSha256: string
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("clientSignerJob")
      .innerJoin(
        "clientSigningIdentity",
        "clientSigningIdentity.id",
        "clientSignerJob.clientSigningIdentityId",
      )
      .select([
        "clientSignerJob.clientSigningIdentityId",
        "clientSignerJob.state",
        "clientSignerJob.claimedBy",
        "clientSignerJob.callbackIdempotencyKey",
        "clientSignerJob.callbackKind",
        "clientSignerJob.callbackSignerId",
        "clientSigningIdentity.keyObjectKey",
        "clientSigningIdentity.keyObjectVersion",
        "clientSigningIdentity.certificateSha256",
      ])
      .where("clientSignerJob.id", "=", input.jobId)
      .where("clientSignerJob.kind", "=", "provision_client_key")
      .forUpdate()
      .executeTakeFirst()
    if (job?.callbackIdempotencyKey === input.idempotencyKey) {
      return (
        job.callbackKind === "complete" &&
        job.callbackSignerId === input.signerId &&
        job.keyObjectKey === input.keyObjectKey &&
        job.keyObjectVersion === input.keyObjectVersion &&
        job.certificateSha256 === input.certificateSha256
      )
    }
    if (
      job === undefined ||
      job.state !== "running" ||
      job.claimedBy !== input.signerId ||
      input.keyObjectKey !== CLIENT_KEY_OBJECT_KEY
    )
      return false
    if (
      (job.keyObjectKey !== null && job.keyObjectKey !== input.keyObjectKey) ||
      (job.keyObjectVersion !== null && job.keyObjectVersion !== input.keyObjectVersion) ||
      (job.certificateSha256 !== null && job.certificateSha256 !== input.certificateSha256)
    )
      return false
    const now = new Date()
    await trx
      .updateTable("clientSignerJob")
      .set({
        state: "succeeded",
        callbackIdempotencyKey: input.idempotencyKey,
        callbackKind: "complete",
        callbackSignerId: input.signerId,
        updatedAt: now,
      })
      .where("id", "=", input.jobId)
      .execute()
    await trx
      .updateTable("clientSigningIdentity")
      .set({
        state: "ready",
        keyObjectKey: input.keyObjectKey,
        keyObjectVersion: input.keyObjectVersion,
        certificateSha256: input.certificateSha256,
        lastError: null,
        updatedAt: now,
      })
      .where("id", "=", job.clientSigningIdentityId)
      .execute()
    return true
  })
}

export async function completeClientSigning(
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
    developerConsoleAccount: string
    idempotencyKey: string
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("clientSignerJob")
      .innerJoin(
        "clientSigningIdentity",
        "clientSigningIdentity.id",
        "clientSignerJob.clientSigningIdentityId",
      )
      .select([
        "clientSignerJob.state",
        "clientSignerJob.clientSigningIdentityId",
        "clientSignerJob.claimedBy",
        "clientSignerJob.versionCode",
        "clientSignerJob.callbackIdempotencyKey",
        "clientSignerJob.callbackKind",
        "clientSignerJob.callbackSignerId",
        "clientSignerJob.signedKey",
        "clientSignerJob.signedObjectVersion",
        "clientSignerJob.signedDigest",
        "clientSignerJob.signedSizeBytes",
        "clientSignerJob.versionName",
        "clientSigningIdentity.packageName",
        "clientSigningIdentity.certificateSha256",
        "clientSigningIdentity.developerConsoleState",
        "clientSigningIdentity.developerConsoleProviderState",
        "clientSigningIdentity.developerConsoleAccount",
      ])
      .where("clientSignerJob.id", "=", input.jobId)
      .where("clientSignerJob.kind", "=", "sign_client_release")
      .forUpdate()
      .executeTakeFirst()
    if (job?.callbackIdempotencyKey === input.idempotencyKey) {
      return (
        job.callbackKind === "complete" &&
        job.callbackSignerId === input.signerId &&
        job.signedKey === input.signedKey &&
        job.signedObjectVersion === input.signedObjectVersion &&
        job.signedDigest === input.signedDigest &&
        job.signedSizeBytes === String(input.signedSizeBytes) &&
        job.versionName === input.versionName &&
        job.versionCode === input.versionCode &&
        job.packageName === input.packageName &&
        job.certificateSha256 === input.certificateSha256 &&
        job.developerConsoleAccount === input.developerConsoleAccount
      )
    }
    if (
      job === undefined ||
      job.state !== "running" ||
      job.claimedBy !== input.signerId ||
      job.versionCode !== input.versionCode ||
      job.packageName !== input.packageName ||
      job.certificateSha256 !== input.certificateSha256 ||
      (job.developerConsoleAccount !== null &&
        job.developerConsoleAccount !== input.developerConsoleAccount) ||
      input.signedKey !== `signed/client/${input.jobId}.apk`
    )
      return false
    const latest = await trx
      .selectFrom("clientRelease")
      .select("versionCode")
      .where("packageName", "=", CLIENT_PACKAGE_NAME)
      .orderBy("versionCode", "desc")
      .limit(1)
      .forUpdate()
      .executeTakeFirst()
    if (input.versionCode <= (latest?.versionCode ?? 0)) return false
    const now = new Date()
    if (
      job.developerConsoleState === "registered" &&
      job.developerConsoleProviderState === "REGISTERED"
    ) {
      await trx
        .insertInto("clientRelease")
        .values({
          id: v7(),
          packageName: CLIENT_PACKAGE_NAME,
          versionName: input.versionName,
          versionCode: input.versionCode,
          apkObjectKey: input.signedKey,
          apkObjectVersion: input.signedObjectVersion,
          apkSha256: input.signedDigest,
          apkSizeBytes: input.signedSizeBytes,
          certificateSha256: input.certificateSha256,
          verifiedAt: now,
        })
        .execute()
    }
    await trx
      .updateTable("clientSignerJob")
      .set({
        state: "succeeded",
        signedKey: input.signedKey,
        signedObjectVersion: input.signedObjectVersion,
        signedDigest: input.signedDigest,
        signedSizeBytes: input.signedSizeBytes,
        versionName: input.versionName,
        callbackIdempotencyKey: input.idempotencyKey,
        callbackKind: "complete",
        callbackSignerId: input.signerId,
        signedAt: now,
        updatedAt: now,
      })
      .where("id", "=", input.jobId)
      .execute()
    await trx
      .updateTable("clientSigningIdentity")
      .set({ developerConsoleAccount: input.developerConsoleAccount, updatedAt: now })
      .where("id", "=", job.clientSigningIdentityId)
      .execute()
    return true
  })
}

/**
 * Record only public provider status and release signed client artifacts after independent proof.
 * OAuth credentials and ownership tokens never cross this boundary.
 */
export async function reconcileClientDeveloperRegistration(
  db: Kysely<DB>,
  providerState: AndroidRegistrationProviderState,
  checkedAt: Date = new Date(),
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const identity = await trx
      .selectFrom("clientSigningIdentity")
      .select(["id", "certificateSha256", "developerConsoleAccount"])
      .where("packageName", "=", CLIENT_PACKAGE_NAME)
      .forUpdate()
      .executeTakeFirst()
    if (
      identity === undefined ||
      identity.certificateSha256 === null ||
      identity.developerConsoleAccount === null
    )
      return
    const certificateSha256 = identity.certificateSha256
    const registered = providerState === "REGISTERED"
    const wrongCertificate = providerState === "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
    await trx
      .updateTable("clientSigningIdentity")
      .set({
        developerConsoleState: registered
          ? "registered"
          : wrongCertificate
            ? "failed"
            : "pending_registration",
        developerConsoleProviderState: providerState,
        developerConsoleLastCheckedAt: checkedAt,
        developerConsoleError: wrongCertificate
          ? "Package name is registered with another signing certificate"
          : null,
        updatedAt: checkedAt,
      })
      .where("id", "=", identity.id)
      .execute()
    if (!registered) return

    const pending = await trx
      .selectFrom("clientSignerJob")
      .select([
        "signedKey",
        "signedObjectVersion",
        "signedDigest",
        "signedSizeBytes",
        "versionCode",
        "versionName",
        "signedAt",
      ])
      .where("clientSigningIdentityId", "=", identity.id)
      .where("kind", "=", "sign_client_release")
      .where("state", "=", "succeeded")
      .where("signedKey", "is not", null)
      .orderBy("versionCode")
      .execute()
    await Promise.all(
      pending.map(async (release) => {
        if (
          release.signedKey === null ||
          release.signedObjectVersion === null ||
          release.signedDigest === null ||
          release.signedSizeBytes === null ||
          release.versionCode === null ||
          release.versionName === null ||
          release.signedAt === null
        )
          return
        await trx
          .insertInto("clientRelease")
          .values({
            id: v7(),
            packageName: CLIENT_PACKAGE_NAME,
            versionName: release.versionName,
            versionCode: release.versionCode,
            apkObjectKey: release.signedKey,
            apkObjectVersion: release.signedObjectVersion,
            apkSha256: release.signedDigest,
            apkSizeBytes: BigInt(release.signedSizeBytes),
            certificateSha256,
            verifiedAt: release.signedAt,
          })
          .onConflict((conflict) => conflict.columns(["packageName", "versionCode"]).doNothing())
          .execute()
      }),
    )
  })
}

export async function failClientSigning(
  db: Kysely<DB>,
  input: {
    jobId: string
    signerId: string
    error: string
    idempotencyKey: string
    maxAttempts?: number
  },
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom("clientSignerJob")
      .select([
        "clientSigningIdentityId",
        "kind",
        "state",
        "claimedBy",
        "attempts",
        "callbackIdempotencyKey",
        "callbackKind",
        "callbackSignerId",
        "error",
      ])
      .where("id", "=", input.jobId)
      .forUpdate()
      .executeTakeFirst()
    if (job?.callbackIdempotencyKey === input.idempotencyKey) {
      return (
        job.callbackKind === "fail" &&
        job.callbackSignerId === input.signerId &&
        job.error === input.error.slice(0, 2000)
      )
    }
    if (job === undefined || job.state !== "running" || job.claimedBy !== input.signerId)
      return false
    const attempts = job.attempts + 1
    const terminal = attempts >= (input.maxAttempts ?? 3)
    await trx
      .updateTable("clientSignerJob")
      .set({
        state: terminal ? "failed" : "queued",
        attempts,
        error: input.error.slice(0, 2000),
        claimedBy: null,
        claimedAt: null,
        callbackIdempotencyKey: input.idempotencyKey,
        callbackKind: "fail",
        callbackSignerId: input.signerId,
        updatedAt: new Date(),
      })
      .where("id", "=", input.jobId)
      .execute()
    if (terminal && job.kind === "provision_client_key") {
      await trx
        .updateTable("clientSigningIdentity")
        .set({ state: "failed", lastError: input.error.slice(0, 2000), updatedAt: new Date() })
        .where("id", "=", job.clientSigningIdentityId)
        .execute()
    }
    return true
  })
}
