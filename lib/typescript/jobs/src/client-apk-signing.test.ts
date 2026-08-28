import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLIENT_KEY_OBJECT_KEY,
  CLIENT_PACKAGE_NAME,
  claimClientSigningJob,
  completeClientKeyProvision,
  completeClientSigning,
  ensureClientSigningIdentity,
  failClientSigning,
  finalizeClientReleaseUpload,
  prepareClientRelease,
} from "./client-apk-signing"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const KEY_1 = "1".repeat(64)
const KEY_2 = "2".repeat(64)
const CERTIFICATE = "c".repeat(64)

beforeEach(async () => {
  if (!reachable) return
  await db.deleteFrom("clientRelease").execute()
  await db.deleteFrom("clientSignerJob").execute()
  await db.deleteFrom("clientSigningIdentity").execute()
})

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("clientRelease").execute()
  await db.deleteFrom("clientSignerJob").execute()
  await db.deleteFrom("clientSigningIdentity").execute()
  await db.destroy()
})

async function provision() {
  const identity = await ensureClientSigningIdentity(db, "operator")
  expect(identity).toMatchObject({ packageName: CLIENT_PACKAGE_NAME, state: "pending" })
  const claim = await claimClientSigningJob(db, "signer")
  if (claim?.kind !== "provision_client_key") throw new Error("expected provision job")
  const completion = {
    jobId: claim.id,
    signerId: "signer",
    keyObjectKey: CLIENT_KEY_OBJECT_KEY,
    keyObjectVersion: "key-v1",
    certificateSha256: CERTIFICATE,
    idempotencyKey: KEY_1,
  }
  expect(await completeClientKeyProvision(db, completion)).toBe(true)
  expect(await completeClientKeyProvision(db, completion)).toBe(true)
  expect(
    await completeClientKeyProvision(db, {
      ...completion,
      keyObjectVersion: "rotated",
    }),
  ).toBe(false)
  return claim
}

async function queuedRelease(versionCode = 1) {
  const prepared = await prepareClientRelease(db, {
    operatorSignerId: "operator",
    packageName: CLIENT_PACKAGE_NAME,
    unsignedDigest: "a".repeat(64),
    sizeBytes: 123n,
    versionCode,
  })
  expect(
    await finalizeClientReleaseUpload(db, {
      jobId: prepared.jobId,
      operatorSignerId: "operator",
      unsignedKey: prepared.unsignedKey,
      unsignedObjectVersion: `raw-v${versionCode}`,
      unsignedDigest: "a".repeat(64),
      sizeBytes: 123n,
      idempotencyKey: KEY_1,
    }),
  ).toBe(true)
  return prepared
}

describe.runIf(reachable)("the catalogue-client signer state machine", () => {
  it("creates one identity and one provision job under concurrent setup", async () => {
    const identities = await Promise.all([
      ensureClientSigningIdentity(db, "operator"),
      ensureClientSigningIdentity(db, "operator"),
    ])
    expect(new Set(identities.map((identity) => identity.packageName))).toEqual(
      new Set([CLIENT_PACKAGE_NAME]),
    )
    expect(
      Number(
        (
          await db
            .selectFrom("clientSignerJob")
            .select((eb) => eb.fn.countAll().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(1)
  })

  it("requeues the same failed provision identity without rotating it", async () => {
    await ensureClientSigningIdentity(db, "operator")
    const claimed = await claimClientSigningJob(db, "signer")
    if (claimed?.kind !== "provision_client_key") throw new Error("expected provision job")
    expect(
      await failClientSigning(db, {
        jobId: claimed.id,
        signerId: "signer",
        error: "tool failed",
        idempotencyKey: KEY_1,
        maxAttempts: 1,
      }),
    ).toBe(true)
    await ensureClientSigningIdentity(db, "operator-2")
    const retried = await claimClientSigningJob(db, "signer-2")
    expect(retried?.id).toBe(claimed.id)
  })

  it("binds prepare and finalize replay to the operator and exact metadata", async () => {
    await provision()
    const first = await prepareClientRelease(db, {
      operatorSignerId: "operator",
      packageName: CLIENT_PACKAGE_NAME,
      unsignedDigest: "a".repeat(64),
      sizeBytes: 123n,
      versionCode: 7,
    })
    expect(
      await prepareClientRelease(db, {
        operatorSignerId: "operator",
        packageName: CLIENT_PACKAGE_NAME,
        unsignedDigest: "a".repeat(64),
        sizeBytes: 123n,
        versionCode: 7,
      }),
    ).toEqual(first)
    const finalize = {
      jobId: first.jobId,
      operatorSignerId: "operator",
      unsignedKey: first.unsignedKey,
      unsignedObjectVersion: "raw-v1",
      unsignedDigest: "a".repeat(64),
      sizeBytes: 123n,
      idempotencyKey: KEY_1,
    }
    expect(await finalizeClientReleaseUpload(db, finalize)).toBe(true)
    expect(await finalizeClientReleaseUpload(db, finalize)).toBe(true)
    expect(await finalizeClientReleaseUpload(db, { ...finalize, operatorSignerId: "other" })).toBe(
      false,
    )
    expect(
      await prepareClientRelease(db, {
        operatorSignerId: "operator",
        packageName: CLIENT_PACKAGE_NAME,
        unsignedDigest: "a".repeat(64),
        sizeBytes: 123n,
        versionCode: 7,
      }),
    ).toEqual({ ...first, state: "queued" })
  })

  it("atomically publishes the signed object version and refuses altered callback replay", async () => {
    await provision()
    const prepared = await queuedRelease(7)
    const claim = await claimClientSigningJob(db, "signer")
    if (claim?.kind !== "sign_client_release") throw new Error("expected release job")
    expect(claim.id).toBe(prepared.jobId)
    const completion = {
      jobId: claim.id,
      signerId: "signer",
      signedKey: `signed/client/${claim.id}.apk`,
      signedObjectVersion: "signed-v1",
      signedDigest: "d".repeat(64),
      signedSizeBytes: 456n,
      packageName: CLIENT_PACKAGE_NAME,
      versionCode: 7,
      versionName: "1.0.0",
      certificateSha256: CERTIFICATE,
      idempotencyKey: KEY_2,
    }
    expect(await completeClientSigning(db, completion)).toBe(true)
    expect(await completeClientSigning(db, completion)).toBe(true)
    expect(await completeClientSigning(db, { ...completion, signedDigest: "e".repeat(64) })).toBe(
      false,
    )
    expect(
      await db
        .selectFrom("clientRelease")
        .select(["versionCode", "apkObjectKey", "apkObjectVersion", "certificateSha256"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      versionCode: 7,
      apkObjectKey: completion.signedKey,
      apkObjectVersion: "signed-v1",
      certificateSha256: CERTIFICATE,
    })
    expect(
      await prepareClientRelease(db, {
        operatorSignerId: "operator",
        packageName: CLIENT_PACKAGE_NAME,
        unsignedDigest: "a".repeat(64),
        sizeBytes: 123n,
        versionCode: 7,
      }),
    ).toEqual({ ...prepared, state: "succeeded" })
  })

  it("rejects a lower completion after a higher version wins", async () => {
    await provision()
    await queuedRelease(2)
    await queuedRelease(3)
    const low = await claimClientSigningJob(db, "low")
    const high = await claimClientSigningJob(db, "high")
    if (low?.kind !== "sign_client_release" || high?.kind !== "sign_client_release")
      throw new Error("expected release jobs")
    const complete = async (job: typeof low, signerId: string, key: string) =>
      await completeClientSigning(db, {
        jobId: job.id,
        signerId,
        signedKey: `signed/client/${job.id}.apk`,
        signedObjectVersion: `signed-v${job.versionCode}`,
        signedDigest: key.repeat(64),
        signedSizeBytes: 456n,
        packageName: CLIENT_PACKAGE_NAME,
        versionCode: job.versionCode,
        versionName: `${job.versionCode}`,
        certificateSha256: CERTIFICATE,
        idempotencyKey: key.repeat(64),
      })
    expect(await complete(high, "high", "3")).toBe(true)
    expect(await complete(low, "low", "2")).toBe(false)
  })
})
