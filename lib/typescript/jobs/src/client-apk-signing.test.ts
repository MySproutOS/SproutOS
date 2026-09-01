import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLIENT_KEY_OBJECT_KEY,
  CLIENT_PACKAGE_NAME,
  ClientSigningConflictError,
  claimClientSigningJob,
  completeClientKeyProvision,
  completeClientSigning,
  ensureClientSigningIdentity,
  failClientSigning,
  finalizeClientReleaseUpload,
  prepareClientRelease,
  reconcileClientDeveloperRegistration,
} from "./client-apk-signing"
import { CLAIM_TIMEOUT_MS } from "./apk-signing"

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
    claimToken: claim.claimToken,
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

async function markRegistrationVerified() {
  await reconcileClientDeveloperRegistration(db, "REGISTERED")
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
        claimToken: claimed.claimToken,
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
    await markRegistrationVerified()
    const prepared = await queuedRelease(7)
    const claim = await claimClientSigningJob(db, "signer")
    if (claim?.kind !== "sign_client_release") throw new Error("expected release job")
    expect(claim.id).toBe(prepared.jobId)
    const completion = {
      jobId: claim.id,
      signerId: "signer",
      claimToken: claim.claimToken,
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
    expect(
      await completeClientSigning(db, {
        ...completion,
        certificateSha256: "9".repeat(64),
        idempotencyKey: KEY_1,
      }),
    ).toBe(false)
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

  it("serializes catalogue releases until the active version succeeds", async () => {
    await provision()
    await markRegistrationVerified()
    await queuedRelease(2)
    await expect(
      prepareClientRelease(db, {
        operatorSignerId: "operator",
        packageName: CLIENT_PACKAGE_NAME,
        unsignedDigest: "b".repeat(64),
        sizeBytes: 123n,
        versionCode: 3,
      }),
    ).rejects.toBeInstanceOf(ClientSigningConflictError)

    const firstClaimAt = new Date("2026-08-28T12:00:00.000Z")
    const versionTwo = await claimClientSigningJob(db, "signer-2", () => firstClaimAt)
    if (versionTwo?.kind !== "sign_client_release") throw new Error("expected release job")
    expect(
      await claimClientSigningJob(db, "signer-3", () => new Date(firstClaimAt.getTime() + 1)),
    ).toBeUndefined()
    const recovered = await claimClientSigningJob(
      db,
      "signer-recovery",
      () => new Date(firstClaimAt.getTime() + CLAIM_TIMEOUT_MS + 1),
    )
    if (recovered?.kind !== "sign_client_release") throw new Error("expected reclaimed release")
    expect(recovered).toMatchObject({ id: versionTwo.id, kind: versionTwo.kind, versionCode: 2 })
    expect(recovered.claimToken).not.toBe(versionTwo.claimToken)
    expect(
      await claimClientSigningJob(
        db,
        "signer-4",
        () => new Date(firstClaimAt.getTime() + CLAIM_TIMEOUT_MS + 2),
      ),
    ).toBeUndefined()
    expect(
      await completeClientSigning(db, {
        jobId: versionTwo.id,
        signerId: "signer-recovery",
        claimToken: recovered.claimToken,
        signedKey: `signed/client/${versionTwo.id}.apk`,
        signedObjectVersion: "signed-v2",
        signedDigest: "2".repeat(64),
        signedSizeBytes: 456n,
        packageName: CLIENT_PACKAGE_NAME,
        versionCode: 2,
        versionName: "2",
        certificateSha256: CERTIFICATE,
        idempotencyKey: KEY_2,
      }),
    ).toBe(true)

    await queuedRelease(3)
    const versionThree = await claimClientSigningJob(db, "signer-3")
    expect(versionThree).toMatchObject({
      kind: "sign_client_release",
      versionCode: 3,
      previousVersionCode: 2,
    })
  })

  it("fences a delayed failure from an expired attempt even when the signer identity is reused", async () => {
    await ensureClientSigningIdentity(db, "operator")
    const firstClaimAt = new Date("2026-08-28T12:00:00.000Z")
    const firstToken = "1".repeat(64)
    const secondToken = "2".repeat(64)
    const first = await claimClientSigningJob(
      db,
      "stable-signer",
      () => firstClaimAt,
      () => firstToken,
    )
    if (first?.kind !== "provision_client_key") throw new Error("expected provision job")

    const reclaimed = await claimClientSigningJob(
      db,
      "stable-signer",
      () => new Date(firstClaimAt.getTime() + CLAIM_TIMEOUT_MS + 1),
      () => secondToken,
    )
    expect(reclaimed).toEqual({ ...first, claimToken: secondToken })

    expect(
      await failClientSigning(db, {
        jobId: first.id,
        signerId: "stable-signer",
        claimToken: firstToken,
        error: "delayed first-attempt failure",
        idempotencyKey: KEY_1,
      }),
    ).toBe(false)
    expect(
      await db
        .selectFrom("clientSignerJob")
        .select(["state", "claimToken", "attempts", "error"])
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "running", claimToken: secondToken, attempts: 0, error: null })

    const currentFailure = {
      jobId: first.id,
      signerId: "stable-signer",
      claimToken: secondToken,
      error: "current-attempt failure",
      idempotencyKey: KEY_2,
    }
    expect(await failClientSigning(db, currentFailure)).toBe(true)
    expect(await failClientSigning(db, currentFailure)).toBe(true)
    expect(
      await db
        .selectFrom("clientSignerJob")
        .select(["state", "claimToken", "attempts", "error", "callbackClaimToken"])
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "queued",
      claimToken: null,
      attempts: 1,
      error: "current-attempt failure",
      callbackClaimToken: secondToken,
    })
  })

  it("keeps a signed client release unpublished until independent registration proof", async () => {
    await provision()
    await queuedRelease(11)
    const claim = await claimClientSigningJob(db, "signer")
    if (claim?.kind !== "sign_client_release") throw new Error("expected release job")
    expect(
      await completeClientSigning(db, {
        jobId: claim.id,
        signerId: "signer",
        claimToken: claim.claimToken,
        signedKey: `signed/client/${claim.id}.apk`,
        signedObjectVersion: "signed-v11",
        signedDigest: "b".repeat(64),
        signedSizeBytes: 456n,
        packageName: CLIENT_PACKAGE_NAME,
        versionCode: 11,
        versionName: "11",
        certificateSha256: CERTIFICATE,
        idempotencyKey: KEY_2,
      }),
    ).toBe(true)
    expect(await db.selectFrom("clientRelease").select("id").execute()).toEqual([])

    await reconcileClientDeveloperRegistration(db, "NOT_REGISTERED")
    expect(await db.selectFrom("clientRelease").select("id").execute()).toEqual([])
    await reconcileClientDeveloperRegistration(db, "REGISTERED")
    expect(
      await db.selectFrom("clientRelease").select("versionCode").executeTakeFirstOrThrow(),
    ).toEqual({ versionCode: 11 })
  })
})
