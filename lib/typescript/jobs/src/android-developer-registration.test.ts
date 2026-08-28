/* oxlint-disable no-await-in-loop -- fixture cleanup follows foreign-key order */
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  androidRegistrationQueueHealth,
  ensureAndroidDeveloperRegistration,
  GoogleAndroidDeveloperStatusChecker,
  reconcileAndroidDeveloperRegistrations,
  verifyAndroidSetupCommit,
} from "./android-developer-registration"
import { completeSigning } from "./apk-signing"

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
const unknownStateFetch: typeof fetch = () =>
  Promise.resolve(new Response(JSON.stringify({ state: "REVIEW_COMPLETE" }), { status: 200 }))

async function seed(): Promise<{ projectId: string; deploymentId: string }> {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const suffix = projectId.replaceAll("-", "").slice(-12)
  await db
    .insertInto("user")
    .values({ id: userId, email: `registration-${suffix}@test.invalid` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `registration-${suffix}`,
      name: "Android registration",
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
      ownerLogin: "sproutos-test",
      name: `registration-${suffix}`,
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
      name: "Android registration",
      slug: `registration${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  projects.push(projectId)
  await db
    .insertInto("deployment")
    .values({ id: deploymentId, projectId, kind: "production", gitSha: "d".repeat(40) })
    .execute()
  created.push({ table: "deployment", id: deploymentId })
  return { projectId, deploymentId }
}

async function claimedSigningJob(projectId: string, deploymentId: string, signerId: string) {
  const jobId = v7()
  await db
    .insertInto("apkSigningJob")
    .values({
      id: jobId,
      deploymentId,
      projectId,
      unsignedKey: `builds/${deploymentId}/app.apk`,
      unsignedDigest: "c".repeat(64),
      status: "claimed",
      claimedBy: signerId,
      claimedAt: new Date(),
    })
    .execute()
  return jobId
}

afterAll(async () => {
  if (!reachable) return
  if (projects.length > 0) {
    await db.deleteFrom("apkSigningJob").where("projectId", "in", projects).execute()
    await db.deleteFrom("androidDeveloperRegistration").where("projectId", "in", projects).execute()
  }
  for (const row of created.toReversed()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe("Google Android Developer ID status client", () => {
  it("uses the documented fingerprint query and API-key header", async () => {
    const calls: { url: URL; init?: RequestInit }[] = []
    const request: typeof fetch = (input, init) => {
      const url =
        input instanceof URL
          ? input
          : input instanceof Request
            ? new URL(input.url)
            : new URL(input)
      calls.push({ url, init })
      return Promise.resolve(
        new Response(JSON.stringify({ state: "REGISTERED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }
    const checker = new GoogleAndroidDeveloperStatusChecker(
      "test-api-key",
      request,
      "https://status.example.test",
    )

    await expect(checker.check("com.example.app", "a".repeat(64))).resolves.toBe("REGISTERED")
    expect(calls[0]?.url.pathname).toBe(
      "/v1/packages/com.example.app/packageRegistrationStatus:check",
    )
    expect(calls[0]?.url.searchParams.get("certificateFingerprint")).toBe("a".repeat(64))
    expect(new Headers(calls[0]?.init?.headers).get("X-Goog-Api-Key")).toBe("test-api-key")
  })

  it("fails closed on undocumented provider states", async () => {
    const checker = new GoogleAndroidDeveloperStatusChecker("key", unknownStateFetch)
    await expect(checker.check("com.example.app", "a".repeat(64))).rejects.toThrow(
      /unknown registration state/,
    )
  })
})

describe.runIf(reachable)("durable Android developer registration", () => {
  it("survives review beyond a claim and promotes only after provider and setup verification", async () => {
    const { projectId, deploymentId } = await seed()
    const packageName = `com.sproutos.app.p${projectId.replaceAll("-", "")}`
    const certificateSha256 = "a".repeat(64)
    await ensureAndroidDeveloperRegistration(db, { projectId, packageName, certificateSha256 })
    await verifyAndroidSetupCommit(db, projectId, "b".repeat(40))

    const jobId = await claimedSigningJob(projectId, deploymentId, "signer")
    expect(
      await completeSigning(db, {
        jobId,
        signerId: "signer",
        signedKey: `signed/${deploymentId}.apk`,
        signedDigest: "d".repeat(64),
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
    ).toBe("queued")

    const began = new Date("2099-01-01T00:00:00.000Z")
    await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.resolve("NOT_REGISTERED") },
      { workerId: "worker-review", now: began },
    )
    const reviewing = await db
      .selectFrom("androidDeveloperRegistration")
      .select(["state", "providerState", "claimedAt", "nextCheckAt"])
      .where("projectId", "=", projectId)
      .executeTakeFirstOrThrow()
    expect(reviewing.state).toBe("pending_registration")
    expect(reviewing.providerState).toBe("NOT_REGISTERED")
    expect(reviewing.claimedAt).toBeNull()
    expect(reviewing.nextCheckAt.getTime()).toBeGreaterThan(began.getTime() + 10 * 60 * 1000)

    await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.resolve("REGISTERED") },
      { workerId: "worker-after-review", now: new Date("2099-01-01T00:16:00.000Z") },
    )
    const registered = await db
      .selectFrom("androidDeveloperRegistration")
      .select(["state", "providerState", "lastFailure"])
      .where("projectId", "=", projectId)
      .executeTakeFirstOrThrow()
    expect(registered).toEqual({
      state: "registered",
      providerState: "REGISTERED",
      lastFailure: null,
    })
    expect(
      (
        await db
          .selectFrom("deployment")
          .select("status")
          .where("id", "=", deploymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("ready")
  })

  it("keeps a provider-registered release queued until the setup commit is verified", async () => {
    const { projectId, deploymentId } = await seed()
    const packageName = `com.sproutos.app.p${projectId.replaceAll("-", "")}`
    await ensureAndroidDeveloperRegistration(db, {
      projectId,
      packageName,
      certificateSha256: "e".repeat(64),
    })
    const jobId = await claimedSigningJob(projectId, deploymentId, "signer-no-setup")
    await completeSigning(db, {
      jobId,
      signerId: "signer-no-setup",
      signedKey: `signed/${deploymentId}.apk`,
      signedDigest: "1".repeat(64),
    })
    await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.resolve("REGISTERED") },
      { workerId: "worker-no-setup", now: new Date("2099-02-01T00:00:00.000Z") },
    )
    const readStatus = async () =>
      (
        await db
          .selectFrom("deployment")
          .select("status")
          .where("id", "=", deploymentId)
          .executeTakeFirstOrThrow()
      ).status
    expect(await readStatus()).toBe("queued")
    await verifyAndroidSetupCommit(db, projectId, "2".repeat(40))
    expect(await readStatus()).toBe("ready")
  })

  it("persists provider failures and exposes queue and worker last-seen state", async () => {
    const { projectId } = await seed()
    await ensureAndroidDeveloperRegistration(db, {
      projectId,
      packageName: `com.sproutos.app.p${projectId.replaceAll("-", "")}`,
      certificateSha256: "3".repeat(64),
    })
    const now = new Date("2099-03-01T00:00:00.000Z")
    const result = await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.reject(new Error("provider unavailable")) },
      { workerId: "worker-failure", now },
    )
    expect(result.failed).toBe(1)
    const row = await db
      .selectFrom("androidDeveloperRegistration")
      .select(["state", "checkAttempts", "lastFailure", "nextCheckAt"])
      .where("projectId", "=", projectId)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("failed")
    expect(row.checkAttempts).toBe(1)
    expect(row.lastFailure).toBe("provider unavailable")
    expect(row.nextCheckAt.getTime()).toBeGreaterThan(now.getTime())
    const health = await androidRegistrationQueueHealth(db, new Date("2100-01-01T00:00:00.000Z"))
    expect(Number(health.pendingCount)).toBeGreaterThanOrEqual(1)
    expect(Number(health.dueCount)).toBeGreaterThanOrEqual(1)
    expect(health.lastSeenAt?.toISOString()).toBe(now.toISOString())
    expect(health.lastCompletedAt?.toISOString()).toBe(now.toISOString())
  })

  it("refuses to replace a project's immutable package or signing certificate", async () => {
    const { projectId } = await seed()
    const input = {
      projectId,
      packageName: `com.sproutos.app.p${projectId.replaceAll("-", "")}`,
      certificateSha256: "4".repeat(64),
    }
    await ensureAndroidDeveloperRegistration(db, input)
    await expect(
      ensureAndroidDeveloperRegistration(db, { ...input, certificateSha256: "5".repeat(64) }),
    ).rejects.toThrow(/immutable/)
  })

  it("enforces provider proof when a writer tries to mark a row registered directly", async () => {
    const { projectId } = await seed()
    await ensureAndroidDeveloperRegistration(db, {
      projectId,
      packageName: `com.sproutos.app.p${projectId.replaceAll("-", "")}`,
      certificateSha256: "6".repeat(64),
    })
    await expect(
      db
        .updateTable("androidDeveloperRegistration")
        .set({ state: "registered" })
        .where("projectId", "=", projectId)
        .execute(),
    ).rejects.toThrow(/android_developer_registration_registered_check/)
  })
})
