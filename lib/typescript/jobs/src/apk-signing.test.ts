import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_TIMEOUT_MS,
  claimSigningJob,
  completeKeyProvision,
  completeSigning,
  enqueueSigning,
  failSigning,
  packageNameForProject,
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
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []
const projects: string[] = []

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
  return { projectId, deploymentId }
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
  expect(
    await completeKeyProvision(db, {
      jobId: job.id,
      signerId: "signer",
      keyObjectKey: `keys/${job.androidAppId}/signing.keystore.enc`,
      keyObjectVersion: "v1",
      certificateSha256: "b".repeat(64),
      developerConsoleState: "pending_registration",
    }),
  ).toBe(true)
}

afterAll(async () => {
  if (!reachable) return
  if (projects.length > 0) {
    await db.deleteFrom("androidSignerJob").where("projectId", "in", projects).execute()
    await db.deleteFrom("androidApp").where("projectId", "in", projects).execute()
  }
  for (const row of [...created].toReversed()) {
    // eslint-disable-next-line no-await-in-loop -- reverse creation order preserves FK cleanup.
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
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

  it("makes a deployment terminal only after verified signing metadata matches", async () => {
    const { deploymentId, jobId } = await queue(7)
    await provision()
    const signing = await claimSigningJob(db, "signer")
    expect(signing?.id).toBe(jobId)
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
        versionCode: 7,
        versionName: "1.0.0",
        certificateSha256: signing.certificateSha256,
      }),
    ).toBe(true)
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
      }),
    ).toBe(false)
  })

  it("marks the deployment error after a terminal signing failure", async () => {
    const { deploymentId, jobId } = await queue()
    await provision()
    await claimSigningJob(db, "signer")
    expect(
      await failSigning(db, { jobId, signerId: "signer", error: "invalid APK", maxAttempts: 1 }),
    ).toBe(true)
    expect(
      await db
        .selectFrom("deployment")
        .select(["status", "failureReason"])
        .where("id", "=", deploymentId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: "error", failureReason: "invalid APK" })
  })

  it("fails blocked releases when per-app key provisioning is terminal", async () => {
    const { deploymentId } = await queue()
    const provisioning = await claimSigningJob(db, "signer")
    if (provisioning?.kind !== "provision_key") throw new Error("expected provisioning job")
    expect(
      await failSigning(db, {
        jobId: provisioning.id,
        signerId: "signer",
        error: "Developer Console ownership proof required",
        developerConsoleState: "ownership_required",
        maxAttempts: 1,
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
  })
})
