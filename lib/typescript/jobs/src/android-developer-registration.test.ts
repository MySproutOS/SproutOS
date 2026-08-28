/* oxlint-disable no-await-in-loop -- fixture cleanup follows foreign-key order */
import { crudAndroidApp } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  ANDROID_REGISTRATION_REVALIDATE_MS,
  AndroidDeveloperStatusError,
  androidRegistrationQueueHealth,
  GoogleAndroidDeveloperStatusChecker,
  reconcileAndroidDeveloperRegistrations,
} from "./android-developer-registration"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: { table: "project" | "repository" | "organization" | "user"; id: string }[] = []
const projectIds: string[] = []
const CONFIG_FINGERPRINT = "f".repeat(64)

async function seedApp(certificate = "a".repeat(64)) {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const suffix = projectId.replaceAll("-", "").slice(-12)
  await db
    .insertInto("user")
    .values({ id: userId, email: `reconcile-${suffix}@test.invalid` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      slug: `reconcile-${suffix}`,
      name: "Android reconciliation",
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
      name: `reconcile-${suffix}`,
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
      name: "Android reconciliation",
      slug: `reconcile${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  projectIds.push(projectId)
  const app = await db
    .insertInto("androidApp")
    .values({
      id: v7(),
      projectId,
      packageName: `me.sproutos.app.p${projectId.replaceAll("-", "")}`,
      certificateSha256: certificate,
      keyObjectKey: `keys/${projectId}/signing.keystore.enc`,
      keyObjectVersion: "v1",
      developerConsoleState: "pending_registration",
      developerConsoleNextCheckAt: new Date("2026-01-01T00:00:00.000Z"),
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return app.id
}

afterAll(async () => {
  if (!reachable) return
  if (projectIds.length > 0) {
    await db.deleteFrom("androidSignerJob").where("projectId", "in", projectIds).execute()
    await db.deleteFrom("androidApp").where("projectId", "in", projectIds).execute()
  }
  for (const row of created.toReversed()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db
    .updateTable("androidRegistrationReconcilerState")
    .set({
      lastSeenAt: null,
      lastCompletedAt: null,
      lastFailure: null,
      quotaReserved: 0,
      terminalBlockedAt: null,
      terminalFailureKind: null,
      terminalConfigFingerprint: null,
    })
    .where("id", "=", "developer-id-status")
    .execute()
  await db.destroy()
})

describe("Google Android Developer ID status client", () => {
  it("uses the documented fingerprint query and API-key header", async () => {
    const calls: { url: URL; init?: RequestInit }[] = []
    const request: typeof fetch = (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
      calls.push({ url, init })
      return Promise.resolve(new Response(JSON.stringify({ state: "REGISTERED" }), { status: 200 }))
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

  it.each([
    [400, "batch_terminal"],
    [401, "batch_terminal"],
    [403, "batch_terminal"],
    [429, "quota"],
    [500, "transient"],
    [503, "transient"],
  ] as const)("classifies HTTP %s as %s", async (status, kind) => {
    const checker = new GoogleAndroidDeveloperStatusChecker("key", () =>
      Promise.resolve(new Response("", { status })),
    )
    let failure: unknown
    try {
      await checker.check("com.example.app", "a".repeat(64))
    } catch (cause: unknown) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(AndroidDeveloperStatusError)
    expect((failure as AndroidDeveloperStatusError).kind).toBe(kind)
  })

  it("treats invalid JSON as a terminal provider-contract failure", async () => {
    const checker = new GoogleAndroidDeveloperStatusChecker("key", () =>
      Promise.resolve(new Response("not-json", { status: 200 })),
    )
    await expect(checker.check("com.example.app", "a".repeat(64))).rejects.toMatchObject({
      kind: "batch_terminal",
      terminalKind: "provider_contract",
    })
  })
})

describe.runIf(reachable)("durable Android registration reconciliation", () => {
  it("registers only from exact provider proof and schedules slow revalidation", async () => {
    const appId = await seedApp()
    const now = new Date("2099-01-01T00:00:00.000Z")
    const result = await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.resolve("REGISTERED") },
      {
        workerId: `worker-${v7()}`,
        configFingerprint: CONFIG_FINGERPRINT,
        androidAppIds: [appId],
        now,
      },
    )
    expect(result.registered).toBe(1)
    const app = await db
      .selectFrom("androidApp")
      .select([
        "developerConsoleState",
        "developerConsoleProviderState",
        "developerConsoleNextCheckAt",
        "createdAt",
      ])
      .where("id", "=", appId)
      .executeTakeFirstOrThrow()
    expect(app.developerConsoleState).toBe("registered")
    expect(app.developerConsoleProviderState).toBe("REGISTERED")
    expect(app.developerConsoleNextCheckAt.getTime()).toBe(
      now.getTime() + ANDROID_REGISTRATION_REVALIDATE_MS,
    )
    const beforeRevalidation = await androidRegistrationQueueHealth(
      db,
      new Date(app.developerConsoleNextCheckAt.getTime() - 1),
      [appId],
    )
    expect(beforeRevalidation.oldestPendingAt?.toISOString()).not.toBe(app.createdAt.toISOString())
    const atRevalidation = await androidRegistrationQueueHealth(
      db,
      app.developerConsoleNextCheckAt,
      [appId],
    )
    expect(Number(atRevalidation.dueCount)).toBe(Number(beforeRevalidation.dueCount))
    expect(Number(atRevalidation.revalidationDueCount)).toBe(
      Number(beforeRevalidation.revalidationDueCount) + 1,
    )
    expect(atRevalidation.oldestPendingAt?.toISOString()).not.toBe(app.createdAt.toISOString())

    const revalidated = await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.resolve("REGISTERED") },
      {
        workerId: `worker-${v7()}`,
        configFingerprint: CONFIG_FINGERPRINT,
        androidAppIds: [appId],
        now: app.developerConsoleNextCheckAt,
      },
    )
    expect(revalidated.registered).toBe(1)
  })

  it("stops a batch on auth/quota errors and releases untouched claims", async () => {
    const first = await seedApp("b".repeat(64))
    const second = await seedApp("c".repeat(64))
    let calls = 0
    const checker = {
      check: () => {
        calls += 1
        return Promise.reject(
          new AndroidDeveloperStatusError(
            "provider credential rejected",
            "batch_terminal",
            401,
            "unauthenticated",
          ),
        )
      },
    }
    const firstResult = await reconcileAndroidDeveloperRegistrations(db, checker, {
      workerId: `worker-${v7()}`,
      configFingerprint: CONFIG_FINGERPRINT,
      androidAppIds: [first, second],
      now: new Date("2099-02-01T00:00:00.000Z"),
      limit: 2,
    })
    expect(firstResult.circuitOpen).toBe(true)
    expect(calls).toBe(1)
    const rows = await db
      .selectFrom("androidApp")
      .select(["id", "developerConsoleClaimToken", "developerConsoleLastFailure"])
      .where("id", "in", [first, second])
      .execute()
    expect(rows.every((row) => row.developerConsoleClaimToken === null)).toBe(true)
    expect(rows.filter((row) => row.developerConsoleLastFailure !== null)).toHaveLength(1)

    const reservedBefore = (
      await db
        .selectFrom("androidRegistrationReconcilerState")
        .select("quotaReserved")
        .where("id", "=", "developer-id-status")
        .executeTakeFirstOrThrow()
    ).quotaReserved
    const repeat = await reconcileAndroidDeveloperRegistrations(db, checker, {
      workerId: `worker-${v7()}`,
      configFingerprint: CONFIG_FINGERPRINT,
      androidAppIds: [first, second],
      now: new Date("2099-02-01T00:01:00.000Z"),
      limit: 2,
    })
    expect(repeat).toMatchObject({ claimed: 0, circuitOpen: true })
    expect(calls).toBe(1)
    expect(
      (
        await db
          .selectFrom("androidRegistrationReconcilerState")
          .select("quotaReserved")
          .where("id", "=", "developer-id-status")
          .executeTakeFirstOrThrow()
      ).quotaReserved,
    ).toBe(reservedBefore)

    const changedConfig = await reconcileAndroidDeveloperRegistrations(db, checker, {
      workerId: `worker-${v7()}`,
      configFingerprint: "a".repeat(64),
      androidAppIds: [first, second],
      now: new Date("2099-02-01T00:02:00.000Z"),
      limit: 2,
    })
    expect(changedConfig.circuitOpen).toBe(true)
    expect(calls).toBe(2)
  })

  it("retains degraded health when a transient row check fails", async () => {
    const appId = await seedApp("d".repeat(64))
    const now = new Date("2099-03-01T00:00:00.000Z")
    const result = await reconcileAndroidDeveloperRegistrations(
      db,
      { check: () => Promise.reject(new Error("provider unavailable")) },
      {
        workerId: `worker-${v7()}`,
        configFingerprint: "e".repeat(64),
        androidAppIds: [appId],
        now,
        limit: 1,
      },
    )
    expect(result.failed).toBe(1)
    const health = await androidRegistrationQueueHealth(db, new Date("2100-01-01T00:00:00.000Z"), [
      appId,
    ])
    expect(Number(health.failureCount)).toBeGreaterThanOrEqual(1)
    expect(Number(health.dueCount)).toBeGreaterThanOrEqual(1)
    expect(health.oldestPendingAt).not.toBeNull()
    expect(health.oldestFailureAt).not.toBeNull()
    expect(health.lastSeenAt?.toISOString()).toBe(now.toISOString())
    expect(health.lastCompletedAt?.toISOString()).toBe(now.toISOString())
    expect(health.lastFailure).toMatch(/1 Android registration provider check/)
  })

  it("resets the durable budget at Pacific midnight, not UTC midnight", async () => {
    const appId = await seedApp("e".repeat(64))
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ quotaProviderDate: sql`date '2026-03-08'`, quotaReserved: 1000 })
      .where("id", "=", "developer-id-status")
      .execute()
    const before = await crudAndroidApp(db).claimDueRegistrations({
      claimToken: `before-${v7()}`,
      now: new Date("2026-03-09T06:59:59.000Z"),
      claimExpiresAt: new Date("2026-03-09T07:09:59.000Z"),
      limit: 1,
      dailyLimit: 1000,
      configFingerprint: "d".repeat(64),
      androidAppIds: [appId],
    })
    expect(before.rows).toEqual([])
    const afterToken = `after-${v7()}`
    const after = await crudAndroidApp(db).claimDueRegistrations({
      claimToken: afterToken,
      now: new Date("2026-03-09T07:00:00.000Z"),
      claimExpiresAt: new Date("2026-03-09T07:10:00.000Z"),
      limit: 1,
      dailyLimit: 1000,
      configFingerprint: "d".repeat(64),
      androidAppIds: [appId],
    })
    expect(after.rows).toHaveLength(1)
    await crudAndroidApp(db).releaseRegistrationClaims(
      afterToken,
      new Date("2026-03-09T07:00:01.000Z"),
    )
    const budget = await db
      .selectFrom("androidRegistrationReconcilerState")
      .select(["quotaProviderDate", "quotaReserved"])
      .where("id", "=", "developer-id-status")
      .executeTakeFirstOrThrow()
    expect(budget.quotaProviderDate.toISOString().slice(0, 10)).toBe("2026-03-09")
    expect(budget.quotaReserved).toBe(1)
  })

  it("serializes concurrent reservations against the global daily budget", async () => {
    const appIds = [await seedApp("f".repeat(64)), await seedApp("1".repeat(64))]
    const now = new Date("2026-06-01T12:00:00.000Z")
    await db
      .updateTable("androidRegistrationReconcilerState")
      .set({ quotaProviderDate: sql`date '2026-06-01'`, quotaReserved: 0 })
      .where("id", "=", "developer-id-status")
      .execute()
    const claims = await Promise.all(
      ["one", "two"].map((worker) =>
        crudAndroidApp(db).claimDueRegistrations({
          claimToken: `${worker}-${v7()}`,
          now,
          claimExpiresAt: new Date(now.getTime() + 60_000),
          limit: 1,
          dailyLimit: 1,
          configFingerprint: "c".repeat(64),
          androidAppIds: appIds,
        }),
      ),
    )
    expect(claims.flatMap((claim) => claim.rows)).toHaveLength(1)
    const budget = await db
      .selectFrom("androidRegistrationReconcilerState")
      .select("quotaReserved")
      .where("id", "=", "developer-id-status")
      .executeTakeFirstOrThrow()
    expect(budget.quotaReserved).toBe(1)
    await db
      .updateTable("androidApp")
      .set({ developerConsoleClaimToken: null, developerConsoleClaimExpiresAt: null })
      .where("developerConsoleClaimToken", "is not", null)
      .execute()
  })
})
