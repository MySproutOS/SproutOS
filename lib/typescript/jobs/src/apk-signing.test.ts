/* oxlint-disable no-await-in-loop -- fixture cleanup follows foreign-key order */
import { fetchAndroidApp } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_TIMEOUT_MS,
  androidVersionError,
  claimSigningJob,
  completeKeyProvision,
  completeSigning,
  enqueueSigning,
  ensureAndroidSetup,
  failSigning,
  packageNameForProject,
  recordDeveloperConsoleState,
  recordVerifiedSetupCommit,
} from "./apk-signing"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: {
  table: "deployment" | "organization" | "project" | "repository" | "user"
  id: string
}[] = []
const projects: string[] = []
const KEY_1 = "1".repeat(64)
const KEY_2 = "2".repeat(64)

async function seed() {
  const userId = v7(),
    organizationId = v7(),
    repositoryId = v7(),
    projectId = v7(),
    deploymentId = v7()
  const suffix = projectId.slice(-12)
  await db
    .insertInto("user")
    .values({ id: userId, email: `android-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `android-${suffix}`,
      name: "Android",
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  created.push({ table: "organization", id: organizationId })
  await db.insertInto("organizationMember").values({ id: v7(), organizationId, userId }).execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
    })
    .execute()
  created.push({ table: "repository", id: repositoryId })
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "App",
      slug: `app${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  projects.push(projectId)
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      preset: "android",
      gitSha: "d".repeat(40),
    })
    .execute()
  created.push({ table: "deployment", id: deploymentId })
  return { projectId, deploymentId, userId }
}

beforeEach(async () => {
  if (!reachable || projects.length === 0) return
  await db.deleteFrom("androidSignerJob").where("projectId", "in", projects).execute()
  await db.deleteFrom("androidApp").where("projectId", "in", projects).execute()
})

async function queue(versionCode = 1) {
  const seeded = await seed()
  const jobId = await enqueueSigning(db, {
    ...seeded,
    unsignedKey: `raw/${seeded.projectId}/${"a".repeat(64)}.apk`,
    unsignedDigest: "a".repeat(64),
    versionCode,
  })
  return { ...seeded, jobId }
}

async function provision() {
  const job = await claimSigningJob(db, "signer")
  expect(job?.kind).toBe("provision_key")
  if (job?.kind !== "provision_key") throw new Error("expected provisioning job")
  const completion = {
    jobId: job.id,
    signerId: "signer",
    keyObjectKey: `keys/${job.androidAppId}/signing.keystore.enc`,
    keyObjectVersion: "v1",
    certificateSha256: "b".repeat(64),
    developerConsoleState: "pending_registration" as const,
    idempotencyKey: KEY_1,
  }
  expect(await completeKeyProvision(db, completion)).toBe(true)
  expect(await completeKeyProvision(db, completion)).toBe(true)
  expect(await completeKeyProvision(db, { ...completion, idempotencyKey: KEY_2 })).toBe(false)
  return job.androidAppId
}

async function recordRegistered(androidAppId: string) {
  const claimToken = `test-registration-${androidAppId}`
  await db
    .updateTable("androidApp")
    .set({
      developerConsoleClaimToken: claimToken,
      developerConsoleClaimExpiresAt: new Date(Date.now() + 60_000),
    })
    .where("id", "=", androidAppId)
    .execute()
  return await recordDeveloperConsoleState(db, {
    androidAppId,
    state: "registered",
    claimToken,
    providerState: "REGISTERED",
    checkedAt: new Date(),
    nextCheckAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
}

afterAll(async () => {
  if (!reachable) return
  if (projects.length > 0) {
    await db.deleteFrom("androidSignerJob").where("projectId", "in", projects).execute()
    await db.deleteFrom("androidApp").where("projectId", "in", projects).execute()
  }
  for (const row of [...created].toReversed())
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  await db.destroy()
})

describe.runIf(reachable)("the Android signer state machine", () => {
  it("provisions one immutable per-app identity before offering its release", async () => {
    const { projectId, jobId } = await queue()
    const first = await claimSigningJob(db, "signer")
    expect(first?.kind).toBe("provision_key")
    expect(first?.packageName).toBe(packageNameForProject(projectId))
    expect(first?.id).not.toBe(jobId)
  })

  it("refuses to mark an app registered without a claimed provider observation", async () => {
    await queue()
    const androidAppId = await provision()
    expect(
      await recordDeveloperConsoleState(db, {
        androidAppId,
        state: "registered",
        providerState: "REGISTERED",
      }),
    ).toBe(false)
  })

  it("refuses a version code above Android's supported maximum before inserting", async () => {
    const seeded = await seed()
    await expect(
      enqueueSigning(db, {
        ...seeded,
        unsignedKey: `raw/${seeded.projectId}/${"a".repeat(64)}.apk`,
        unsignedDigest: "a".repeat(64),
        versionCode: 2_100_000_001,
      }),
    ).rejects.toThrow(/between 1 and 2100000000/)
  })

  it("makes a deployment terminal only after verified signing metadata matches", async () => {
    const { deploymentId, jobId } = await queue(7)
    const androidAppId = await provision()
    expect(await recordRegistered(androidAppId)).toBe(true)
    expect(await recordVerifiedSetupCommit(db, androidAppId, "e".repeat(40))).toBe(true)
    const signing = await claimSigningJob(db, "signer")
    expect(signing?.id).toBe(jobId)
    if (signing?.kind !== "sign_release") throw new Error("expected signing job")
    const completion = {
      jobId,
      signerId: "signer",
      signedKey: `signed/${signing.androidAppId}/${jobId}.apk`,
      signedObjectVersion: "signed-v1",
      signedDigest: "c".repeat(64),
      signedSizeBytes: 42n,
      packageName: signing.packageName,
      versionCode: 7,
      versionName: "1.0.0",
      certificateSha256: signing.certificateSha256,
      idempotencyKey: KEY_1,
    }
    expect(await completeSigning(db, completion)).toBe(true)
    // The response can disappear after the transaction commits. The same callback must converge
    // instead of turning a successful release into an apparent lost-claim failure.
    expect(await completeSigning(db, completion)).toBe(true)
    expect(await completeSigning(db, { ...completion, idempotencyKey: KEY_2 })).toBe(false)
    expect(
      (
        await db
          .selectFrom("deployment")
          .select("status")
          .where("id", "=", deploymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("ready")
    expect(
      await db
        .selectFrom("androidApp")
        .select(["lastAcceptedVersionCode", "latestGoodDeploymentId"])
        .where("projectId", "=", signing.projectId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ lastAcceptedVersionCode: 7, latestGoodDeploymentId: deploymentId })
  })

  it("keeps a signed deployment private until registration and setup verification both finish", async () => {
    const { deploymentId, jobId, userId } = await queue(11)
    const androidAppId = await provision()
    const signing = await claimSigningJob(db, "signer")
    if (signing?.kind !== "sign_release") throw new Error("expected signing job")

    expect(
      await completeSigning(db, {
        jobId,
        signerId: "signer",
        signedKey: `signed/${signing.androidAppId}/${jobId}.apk`,
        signedObjectVersion: "signed-v1",
        signedDigest: "c".repeat(64),
        signedSizeBytes: 42n,
        packageName: signing.packageName,
        versionCode: 11,
        versionName: "1.1.0",
        certificateSha256: signing.certificateSha256,
        idempotencyKey: KEY_1,
      }),
    ).toBe(true)

    const deploymentStatus = async () =>
      (
        await db
          .selectFrom("deployment")
          .select("status")
          .where("id", "=", deploymentId)
          .executeTakeFirstOrThrow()
      ).status
    expect(await deploymentStatus()).toBe("queued")
    expect(await fetchAndroidApp(db).listPersonalCatalogue(userId)).toEqual([])
    expect(await recordRegistered(androidAppId)).toBe(true)
    expect(await deploymentStatus()).toBe("queued")
    expect(await fetchAndroidApp(db).listPersonalCatalogue(userId)).toEqual([])
    expect(await recordVerifiedSetupCommit(db, androidAppId, "e".repeat(40))).toBe(true)
    expect(await deploymentStatus()).toBe("ready")
    expect(await fetchAndroidApp(db).listPersonalCatalogue(userId)).toHaveLength(1)

    await db
      .updateTable("deployment")
      .set({ status: "queued" })
      .where("id", "=", deploymentId)
      .execute()
    expect(await fetchAndroidApp(db).listPersonalCatalogue(userId)).toEqual([])
    await db
      .updateTable("deployment")
      .set({ status: "ready" })
      .where("id", "=", deploymentId)
      .execute()

    expect(
      await recordDeveloperConsoleState(db, {
        androidAppId,
        state: "failed",
        error: "registration revoked",
      }),
    ).toBe(true)
    expect(await deploymentStatus()).toBe("queued")
    expect(await fetchAndroidApp(db).listPersonalCatalogue(userId)).toEqual([])
  })

  it("does not let stale or mismatched completion replace the last good release", async () => {
    const { jobId } = await queue()
    await provision()
    const held = await claimSigningJob(db, "old")
    if (held?.kind !== "sign_release") throw new Error("expected signing job")
    await claimSigningJob(db, "new", () => new Date(Date.now() + CLAIM_TIMEOUT_MS + 1_000))
    expect(
      await completeSigning(db, {
        jobId,
        signerId: "old",
        signedKey: `signed/${held.androidAppId}/${jobId}.apk`,
        signedObjectVersion: "signed-v1",
        signedDigest: "c".repeat(64),
        signedSizeBytes: 42n,
        packageName: held.packageName,
        versionCode: 1,
        versionName: "1",
        certificateSha256: held.certificateSha256,
        idempotencyKey: KEY_1,
      }),
    ).toBe(false)
  })

  it("marks the deployment error after a terminal signing failure", async () => {
    const { deploymentId, jobId } = await queue()
    await provision()
    await claimSigningJob(db, "signer")
    expect(
      await failSigning(db, {
        jobId,
        signerId: "signer",
        error: "invalid APK",
        maxAttempts: 1,
        idempotencyKey: KEY_1,
      }),
    ).toBe(true)
    expect(
      await db
        .selectFrom("deployment")
        .select(["status", "failureReason"])
        .where("id", "=", deploymentId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: "error", failureReason: "invalid APK" })
  })

  it("does not let a terminal failed job burn an unpublished version code", async () => {
    const { projectId, jobId } = await queue(17)
    await provision()
    await claimSigningJob(db, "signer")
    expect(
      await failSigning(db, {
        jobId,
        signerId: "signer",
        error: "invalid APK",
        maxAttempts: 1,
        idempotencyKey: KEY_1,
      }),
    ).toBe(true)
    expect(await androidVersionError(db, projectId, 17)).toBeUndefined()

    const deploymentId = v7()
    await db
      .insertInto("deployment")
      .values({
        id: deploymentId,
        projectId,
        kind: "production",
        preset: "android",
        gitSha: "f".repeat(40),
      })
      .execute()
    created.push({ table: "deployment", id: deploymentId })
    await expect(
      enqueueSigning(db, {
        deploymentId,
        projectId,
        unsignedKey: `raw/${projectId}/${"d".repeat(64)}.apk`,
        unsignedDigest: "d".repeat(64),
        versionCode: 17,
      }),
    ).resolves.toMatch(/[0-9a-f-]{36}/)
  })

  it("records a retried failure callback only once per claim", async () => {
    const { jobId } = await queue()
    await provision()
    await claimSigningJob(db, "signer")
    const failure = {
      jobId,
      signerId: "signer",
      error: "temporary tool failure",
      maxAttempts: 3,
      idempotencyKey: KEY_1,
    }
    expect(await failSigning(db, failure)).toBe(true)
    expect(await failSigning(db, failure)).toBe(true)
    expect(
      await db
        .selectFrom("androidSignerJob")
        .select(["state", "attempts"])
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "queued", attempts: 1 })

    // A new claim clears the old callback key, so the same diagnostic on a genuinely new attempt
    // is counted rather than mistaken for another delivery of the prior callback.
    await claimSigningJob(db, "signer")
    expect(await failSigning(db, failure)).toBe(true)
    expect(
      await db
        .selectFrom("androidSignerJob")
        .select("attempts")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ attempts: 2 })
  })

  it("fails blocked releases when per-app key provisioning is terminal", async () => {
    const { deploymentId, projectId } = await queue()
    const provisioning = await claimSigningJob(db, "signer")
    if (provisioning?.kind !== "provision_key") throw new Error("expected provisioning job")
    expect(
      await failSigning(db, {
        jobId: provisioning.id,
        signerId: "signer",
        error: "Developer Console ownership proof required",
        developerConsoleState: "ownership_required",
        maxAttempts: 1,
        idempotencyKey: KEY_1,
      }),
    ).toBe(true)
    expect(
      await db
        .selectFrom("deployment")
        .select(["status", "failureReason"])
        .where("id", "=", deploymentId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: "error",
      failureReason: "Developer Console ownership proof required",
    })

    await ensureAndroidSetup(db, projectId)
    expect(
      await db
        .selectFrom("androidApp")
        .select(["developerConsoleState", "developerConsoleError", "lastError"])
        .where("projectId", "=", projectId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      developerConsoleState: "pending",
      developerConsoleError: null,
      lastError: null,
    })
    const retried = await claimSigningJob(db, "replacement-signer")
    expect(retried).toMatchObject({
      id: provisioning.id,
      kind: "provision_key",
      androidAppId: provisioning.androidAppId,
    })
  })
})
