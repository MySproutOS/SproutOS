import { crudSandbox, crudSandboxDatabaseBranch } from "@lib/dao"
import { SandboxNotFoundError } from "@lib/sandbox"
import type { NeonPostgresConfig } from "@lib/services"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  destroySandbox,
  meterSandboxes,
  reconcileSandboxes,
  reapExpiredDatabaseBranches,
  repairDeletingSandboxes,
  SANDBOX_KINDS,
  stopSandbox,
} from "./sandbox"

const reachable = await db
  .selectFrom("region")
  .select("id")
  .limit(1)
  .execute()
  .then(
    () => true,
    () => false,
  )

describe.skipIf(!reachable)("sandbox database branch lifecycle", () => {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const regionId = v7()
  const backendServiceId = v7()
  const instanceId = v7()
  const sandboxId = v7()
  const defaultBranchId = v7()
  const expiredBranchId = v7()
  const secondExpiredBranchId = v7()
  const futureBranchId = v7()
  const dropped: string[] = []
  let destroyedProviderId: string | undefined

  const config = {
    neon: {
      apiKey: "unused",
      apiUrl: "https://neon.invalid",
      orgId: "unused",
      regionId: "aws-us-east-1",
    },
    publicHost: "pg.test",
    publicPort: 5432,
  } satisfies NeonPostgresConfig

  const drop = async (database: typeof db, _config: NeonPostgresConfig, branchId: string) => {
    dropped.push(branchId)
    await database.deleteFrom("databaseBranch").where("id", "=", branchId).execute()
  }

  beforeAll(async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@test.invalid`, name: "Branch lifecycle" })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Branch lifecycle",
        slug: `branch-lifecycle-${organizationId.slice(-8)}`,
        kind: "personal",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: BigInt(Date.now()),
        ownerLogin: "sprout-test",
        name: `branch-lifecycle-${repositoryId.slice(-8)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Branch lifecycle",
        slug: `branch-lifecycle-${projectId.slice(-8)}`,
      })
      .execute()
    await db
      .insertInto("region")
      .values({ id: regionId, code: `branch-${regionId.slice(-8)}`, displayName: "Branch test" })
      .execute()
    await db
      .insertInto("backendService")
      .values({
        id: backendServiceId,
        organizationId,
        projectId,
        regionId,
        name: "postgres",
        kind: "postgres",
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseInstance")
      .values({
        id: instanceId,
        backendServiceId,
        projectId,
        provider: "neon",
        providerProjectId: `provider-${instanceId}`,
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseBranch")
      .values([
        {
          id: defaultBranchId,
          databaseInstanceId: instanceId,
          name: "sandbox-default",
          kind: "dev",
        },
        {
          id: expiredBranchId,
          databaseInstanceId: instanceId,
          parentBranchId: defaultBranchId,
          name: "sandbox-expired",
          kind: "dev",
          expiresAt: new Date("2020-01-01T00:00:00Z"),
        },
        {
          id: futureBranchId,
          databaseInstanceId: instanceId,
          parentBranchId: defaultBranchId,
          name: "sandbox-future",
          kind: "dev",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
        },
        {
          id: secondExpiredBranchId,
          databaseInstanceId: instanceId,
          parentBranchId: defaultBranchId,
          name: "sandbox-expired-second",
          kind: "dev",
          expiresAt: new Date("2020-01-02T00:00:00Z"),
        },
      ])
      .execute()
    await crudSandbox(db).create({
      id: sandboxId,
      projectId,
      userId,
      databaseBranchId: defaultBranchId,
      externalId: `daytona-${sandboxId}`,
      state: "deleting",
    })
    for (const databaseBranchId of [
      defaultBranchId,
      expiredBranchId,
      secondExpiredBranchId,
      futureBranchId,
    ]) {
      await crudSandboxDatabaseBranch(db).create({ sandboxId, databaseBranchId })
    }
  })

  afterAll(async () => {
    await db.deleteFrom("databaseInstance").where("id", "=", instanceId).execute()
    await db.deleteFrom("backendService").where("id", "=", backendServiceId).execute()
    await db.deleteFrom("project").where("id", "=", projectId).execute()
    await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
    await db.deleteFrom("region").where("id", "=", regionId).execute()
  })

  it("cleans the default branch when reconciliation finds no Daytona object", async () => {
    const missingSandboxId = v7()
    const missingBranchId = v7()
    const externalId = `daytona-missing-${missingSandboxId}`
    await db
      .insertInto("databaseBranch")
      .values({
        id: missingBranchId,
        databaseInstanceId: instanceId,
        name: `sandbox-missing-${missingBranchId}`,
        kind: "dev",
      })
      .execute()
    await crudSandbox(db).create({
      id: missingSandboxId,
      projectId,
      userId,
      databaseBranchId: missingBranchId,
      externalId,
      purpose: "upstream_resolution",
      state: "running",
      meteredThrough: new Date(),
    })
    await crudSandboxDatabaseBranch(db).create({
      sandboxId: missingSandboxId,
      databaseBranchId: missingBranchId,
    })

    await reconcileSandboxes(
      () =>
        ({
          state: () => Promise.reject(new SandboxNotFoundError(externalId)),
        }) as never,
      drop,
      () => config,
    )({ id: v7(), kind: SANDBOX_KINDS.reconcile, payload: {} } as never, { db } as never)

    const repaired = await db
      .selectFrom("sandbox")
      .select(["state", "externalId", "databaseBranchId"])
      .where("id", "=", missingSandboxId)
      .executeTakeFirstOrThrow()
    expect(repaired).toEqual({ state: "stopped", externalId: null, databaseBranchId: null })
    expect(dropped).toContain(missingBranchId)
    await expect(
      db
        .selectFrom("databaseBranch")
        .select("id")
        .where("id", "=", missingBranchId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
    await db.deleteFrom("sandbox").where("id", "=", missingSandboxId).execute()
    dropped.splice(dropped.indexOf(missingBranchId), 1)
  })

  it("makes a failed missing-object cleanup durable for the branch reaper", async () => {
    const missingSandboxId = v7()
    const missingBranchId = v7()
    const externalId = `daytona-cleanup-failure-${missingSandboxId}`
    await db
      .insertInto("databaseBranch")
      .values({
        id: missingBranchId,
        databaseInstanceId: instanceId,
        name: `sandbox-cleanup-failure-${missingBranchId}`,
        kind: "dev",
      })
      .execute()
    await crudSandbox(db).create({
      id: missingSandboxId,
      projectId,
      userId,
      databaseBranchId: missingBranchId,
      externalId,
      purpose: "upstream_resolution",
      state: "running",
      meteredThrough: new Date(),
    })
    await crudSandboxDatabaseBranch(db).create({
      sandboxId: missingSandboxId,
      databaseBranchId: missingBranchId,
    })

    await reconcileSandboxes(
      () =>
        ({
          state: () => Promise.reject(new SandboxNotFoundError(externalId)),
        }) as never,
      () => Promise.reject(new Error("Neon delete unavailable")),
      () => config,
    )({ id: v7(), kind: SANDBOX_KINDS.reconcile, payload: {} } as never, { db } as never)

    const sandbox = await db
      .selectFrom("sandbox")
      .select(["state", "externalId", "databaseBranchId", "meteredThrough"])
      .where("id", "=", missingSandboxId)
      .executeTakeFirstOrThrow()
    expect(sandbox).toMatchObject({
      state: "failed",
      externalId,
      databaseBranchId: missingBranchId,
    })
    expect(sandbox.meteredThrough).toBeInstanceOf(Date)
    const branch = await db
      .selectFrom("databaseBranch")
      .select(["expiresAt", "cleanupAttempts", "cleanupRetryAt"])
      .where("id", "=", missingBranchId)
      .executeTakeFirstOrThrow()
    expect(branch.expiresAt).toBeInstanceOf(Date)
    expect(branch.cleanupAttempts).toBe(1)
    expect(branch.cleanupRetryAt).toBeInstanceOf(Date)

    await meterSandboxes(
      { id: v7(), kind: SANDBOX_KINDS.meter, payload: {} } as never,
      { db } as never,
    )
    await expect(
      db
        .selectFrom("sandbox")
        .select("meteredThrough")
        .where("id", "=", missingSandboxId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ meteredThrough: sandbox.meteredThrough })
    await db.deleteFrom("sandbox").where("id", "=", missingSandboxId).execute()
    await db.deleteFrom("databaseBranch").where("id", "=", missingBranchId).execute()
  })

  it("routes stop NotFound through the same durable provider-loss cleanup", async () => {
    const missingSandboxId = v7()
    const missingBranchId = v7()
    const externalId = `daytona-stop-missing-${missingSandboxId}`
    await db
      .insertInto("databaseBranch")
      .values({
        id: missingBranchId,
        databaseInstanceId: instanceId,
        name: `sandbox-stop-missing-${missingBranchId}`,
        kind: "dev",
      })
      .execute()
    await crudSandbox(db).create({
      id: missingSandboxId,
      projectId,
      userId,
      databaseBranchId: missingBranchId,
      externalId,
      purpose: "upstream_resolution",
      state: "running",
      meteredThrough: new Date(),
    })
    await crudSandboxDatabaseBranch(db).create({
      sandboxId: missingSandboxId,
      databaseBranchId: missingBranchId,
    })

    await stopSandbox(
      () =>
        ({
          stop: () => Promise.reject(new SandboxNotFoundError(externalId)),
        }) as never,
      drop,
      () => config,
    )(
      { id: v7(), kind: SANDBOX_KINDS.stop, payload: { sandboxId: missingSandboxId } } as never,
      { db } as never,
    )

    await expect(
      db
        .selectFrom("sandbox")
        .select(["state", "externalId", "databaseBranchId"])
        .where("id", "=", missingSandboxId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "stopped", externalId: null, databaseBranchId: null })
    await expect(
      db
        .selectFrom("databaseBranch")
        .select("id")
        .where("id", "=", missingBranchId)
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
    await db.deleteFrom("sandbox").where("id", "=", missingSandboxId).execute()
    dropped.splice(dropped.indexOf(missingBranchId), 1)
  })

  it("reaps expired alternatives and destruction removes every remaining owned branch", async () => {
    await expect(
      reapExpiredDatabaseBranches(
        async (database, branchConfig, branchId) => {
          if (branchId === expiredBranchId) throw new Error("oldest provider branch is locked")
          await drop(database, branchConfig, branchId)
        },
        () => config,
      )(
        { id: v7(), kind: SANDBOX_KINDS.reapDatabaseBranches, payload: {} } as never,
        { db } as never,
      ),
    ).rejects.toThrow("1 expired database branch cleanup attempt")
    expect(dropped).toContain(secondExpiredBranchId)
    expect(dropped).not.toContain(expiredBranchId)
    expect(dropped).not.toContain(futureBranchId)
    const deferred = await db
      .selectFrom("databaseBranch")
      .select(["cleanupAttempts", "cleanupRetryAt"])
      .where("id", "=", expiredBranchId)
      .executeTakeFirstOrThrow()
    expect(deferred.cleanupAttempts).toBe(1)
    expect(deferred.cleanupRetryAt).not.toBeNull()

    await db
      .insertInto("backgroundJob")
      .values({
        id: v7(),
        kind: SANDBOX_KINDS.destroy,
        organizationId,
        payload: { sandboxId },
        state: "dead_lettered",
        idempotencyKey: `${SANDBOX_KINDS.destroy}:${sandboxId}`,
      })
      .execute()
    await repairDeletingSandboxes(
      { id: v7(), kind: SANDBOX_KINDS.repairDestroy, payload: {} } as never,
      { db } as never,
    )
    const repaired = await db
      .selectFrom("backgroundJob")
      .select(["state", "idempotencyKey"])
      .where("kind", "=", SANDBOX_KINDS.destroy)
      .where("idempotencyKey", "like", `${SANDBOX_KINDS.destroy}:${sandboxId}:repair:%`)
      .executeTakeFirstOrThrow()
    expect(repaired.state).toBe("queued")

    await destroySandbox(
      () =>
        ({
          destroy: (externalId: string) => {
            destroyedProviderId = externalId
            return Promise.resolve()
          },
        }) as never,
      drop,
      () => config,
    )(
      {
        id: v7(),
        kind: SANDBOX_KINDS.destroy,
        organizationId,
        payload: { sandboxId },
      } as never,
      { db } as never,
    )

    expect(destroyedProviderId).toBe(`daytona-${sandboxId}`)
    expect(new Set(dropped)).toEqual(
      new Set([secondExpiredBranchId, expiredBranchId, defaultBranchId, futureBranchId]),
    )
    await expect(
      db.selectFrom("sandbox").select("id").where("id", "=", sandboxId).executeTakeFirst(),
    ).resolves.toBeUndefined()
    await expect(
      db
        .selectFrom("databaseBranch")
        .select("id")
        .where("id", "in", [
          defaultBranchId,
          expiredBranchId,
          secondExpiredBranchId,
          futureBranchId,
        ])
        .execute(),
    ).resolves.toEqual([])
  })
})
