import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import {
  createDevBranch,
  devBranchProviderName,
  DevBranchQuotaExceededError,
  type DevBranchDependencies,
  type NeonPostgresConfig,
} from "./index"
import { databaseNameFor } from "./naming"
import { encodeShortId } from "./tenant-auth"

const reachable = await db
  .selectFrom("region")
  .select("id")
  .limit(1)
  .execute()
  .then(
    () => true,
    () => false,
  )

describe.skipIf(!reachable)("durable dev branch reservations", () => {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const backendServiceId = v7()
  const instanceId = v7()
  const primaryBranchId = v7()
  const defaultBranchId = v7()
  const sandboxId = v7()
  let regionId = ""

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

  beforeAll(async () => {
    regionId = (await db.selectFrom("region").select("id").executeTakeFirstOrThrow()).id
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@test.invalid`, name: "Reservation test" })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Reservation test",
        slug: `reservation-${organizationId.slice(-8)}`,
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
        name: `reservation-${repositoryId.slice(-8)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Reservation project",
        slug: `reservation-${projectId.slice(-8)}`,
      })
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
        providerProjectId: "provider-project",
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseBranch")
      .values([
        {
          id: primaryBranchId,
          databaseInstanceId: instanceId,
          name: "main",
          kind: "primary",
          providerBranchId: "provider-primary",
          isProtected: true,
        },
        {
          id: defaultBranchId,
          databaseInstanceId: instanceId,
          name: "sandbox-default",
          kind: "dev",
          parentBranchId: primaryBranchId,
          providerBranchId: "provider-default",
        },
      ])
      .execute()
    await db
      .insertInto("sandbox")
      .values({
        id: sandboxId,
        projectId,
        userId,
        databaseBranchId: defaultBranchId,
        externalId: `daytona-${sandboxId}`,
        state: "running",
      })
      .execute()
    // Deliberately omit sandbox_database_branch: this is the rolling-deploy shape self-healing
    // must repair before it counts quota.
  })

  afterEach(async () => {
    await db
      .deleteFrom("databaseBranch")
      .where("databaseInstanceId", "=", instanceId)
      .where("id", "not in", [primaryBranchId, defaultBranchId])
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("sandbox").where("id", "=", sandboxId).execute()
    await db.deleteFrom("databaseInstance").where("id", "=", instanceId).execute()
    await db.deleteFrom("backendService").where("id", "=", backendServiceId).execute()
    await db.deleteFrom("project").where("id", "=", projectId).execute()
    await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  })

  function fakeProvider(
    options: {
      ambiguousCreate?: boolean
      beforeSeal?: () => Promise<void>
      failDelete?: boolean
      failSeal?: boolean
      pauseList?: { entered: () => void; release: Promise<void> }
    } = {},
  ) {
    const branches: {
      id: string
      name: string
      parent_id?: string | null
      primary?: boolean
    }[] = [
      { id: "provider-primary", name: "main", primary: true },
      { id: "provider-default", name: "sandbox-default", parent_id: "provider-primary" },
    ]
    const deleted: string[] = []
    let creates = 0
    const dependencies: Partial<DevBranchDependencies> = {
      api: () => ({
        listBranches: async () => {
          if (options.pauseList !== undefined) {
            options.pauseList.entered()
            await options.pauseList.release
          }
          return [...branches]
        },
        createBranch: (input) => {
          creates += 1
          const branch = {
            id: `provider-${input.name}`,
            name: input.name,
            parent_id: input.parentId,
          }
          branches.push(branch)
          if (options.ambiguousCreate === true) {
            return Promise.reject(new Error("response lost after create"))
          }
          return Promise.resolve({
            branch,
            connectionUri: "postgresql://owner:provider-secret@branch.neon.test/neondb",
          })
        },
        deleteBranch: (_projectId, branchId) => {
          if (options.failDelete === true) return Promise.reject(new Error("delete unavailable"))
          deleted.push(branchId)
          const index = branches.findIndex(({ id }) => id === branchId)
          if (index >= 0) branches.splice(index, 1)
          return Promise.resolve()
        },
        listDatabases: () => Promise.resolve([{ name: "neondb", owner_name: "owner" }]),
        listRoles: () => Promise.resolve([{ name: "owner" }]),
        getConnectionUri: () =>
          Promise.resolve("postgresql://owner:provider-secret@branch.neon.test/neondb"),
      }),
      seal: async () => {
        await options.beforeSeal?.()
        if (options.failSeal === true) throw new Error("KMS unavailable")
        return { ciphertext: "cipher", wrappedDek: "wrapped", kmsKeyId: "key" }
      },
      hash: () => Promise.resolve("hash"),
    }
    return { branches, deleted, dependencies, creates: () => creates }
  }

  const input = (label: string, maxOwnedBranches = 5) => ({
    backendServiceId,
    organizationId,
    label,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    parentDatabaseBranchId: defaultBranchId,
    ownerSandboxId: sandboxId,
    maxOwnedBranches,
  })

  it("adopts a deterministic branch after an ambiguous create response", async () => {
    const provider = fakeProvider({ ambiguousCreate: true })
    const created = await createDevBranch(db, config, input("ambiguous"), provider.dependencies)
    const row = await db
      .selectFrom("databaseBranch")
      .select(["providerBranchId", "providerBranchName", "provisioningState"])
      .where("id", "=", created.databaseBranchId)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      providerBranchId: `provider-${row.providerBranchName}`,
      provisioningState: "active",
    })
    expect(provider.creates()).toBe(1)
    expect(provider.branches.filter(({ id }) => id === row.providerBranchId)).toHaveLength(1)
    expect(new URL(created.uri).pathname).toBe(`/${databaseNameFor(backendServiceId)}`)
  })

  it("deletes provider state when KMS fails and keeps the reservation when cleanup fails", async () => {
    const cleaned = fakeProvider({ failSeal: true })
    await expect(
      createDevBranch(db, config, input("kms-cleaned"), cleaned.dependencies),
    ).rejects.toThrow("KMS unavailable")
    expect(cleaned.deleted).toHaveLength(1)
    const cleanedTombstone = await db
      .selectFrom("databaseBranch")
      .select([
        "providerBranchId",
        "providerBranchName",
        "provisioningState",
        "reservationToken",
        "deletedAt",
      ])
      .where("name", "like", "%kms-cleaned")
      .executeTakeFirstOrThrow()
    expect(cleanedTombstone).toMatchObject({
      provisioningState: "deleted",
      providerBranchId: `provider-${cleanedTombstone.providerBranchName}`,
      reservationToken: null,
    })
    expect(cleanedTombstone.deletedAt).toBeInstanceOf(Date)

    const durable = fakeProvider({ failDelete: true, failSeal: true })
    await expect(
      createDevBranch(db, config, input("kms-durable"), durable.dependencies),
    ).rejects.toThrow("remains durably reserved for cleanup")
    const reservation = await db
      .selectFrom("databaseBranch")
      .select(["providerBranchId", "providerBranchName", "provisioningState"])
      .where("name", "like", "%kms-durable")
      .executeTakeFirstOrThrow()
    expect(reservation).toMatchObject({
      provisioningState: "cleanup",
      providerBranchId: `provider-${reservation.providerBranchName}`,
    })
  })

  it("cleans the deterministic provider identity if the reservation is concurrently removed", async () => {
    const provider = fakeProvider({
      failSeal: true,
      beforeSeal: async () => {
        await db
          .deleteFrom("databaseBranch")
          .where("databaseInstanceId", "=", instanceId)
          .where("name", "like", "%cascade-cleanup")
          .execute()
      },
    })
    await expect(
      createDevBranch(db, config, input("cascade-cleanup"), provider.dependencies),
    ).rejects.toThrow("KMS unavailable")
    expect(provider.deleted).toHaveLength(1)
    expect(provider.branches).toHaveLength(2)
  })

  it("serializes quota reservations and self-heals the missing default ownership", async () => {
    const provider = fakeProvider()
    const outcomes = await Promise.allSettled([
      createDevBranch(db, config, input("race-one", 2), provider.dependencies),
      createDevBranch(db, config, input("race-two", 2), provider.dependencies),
    ])
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    const rejected = outcomes.find(({ status }) => status === "rejected")
    expect(rejected?.status).toBe("rejected")
    if (rejected?.status !== "rejected") throw new Error("expected one rejected reservation")
    expect(rejected.reason).toBeInstanceOf(DevBranchQuotaExceededError)
    expect(provider.creates()).toBe(1)
    const ownership = await db
      .selectFrom("sandboxDatabaseBranch")
      .select("databaseBranchId")
      .where("sandboxId", "=", sandboxId)
      .execute()
    expect(ownership.map(({ databaseBranchId }) => databaseBranchId)).toContain(defaultBranchId)
  })

  it("commits the reservation before waiting on Neon", async () => {
    let entered!: () => void
    const atProvider = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const providerRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = fakeProvider({ pauseList: { entered, release: providerRelease } })
    const creating = createDevBranch(db, config, input("outside-lock"), provider.dependencies)
    await atProvider

    await db.transaction().execute(async (tx) => {
      await tx.selectFrom("sandbox").select("id").where("id", "=", sandboxId).forUpdate().execute()
    })
    release()
    const created = await creating
    expect(created.name).toContain("outside-lock")
  })

  it("uses both complete UUID identities in a bounded provider name", () => {
    const branchId = v7()
    const name = devBranchProviderName(sandboxId, branchId)
    expect(name).toBe(`sb-${encodeShortId(sandboxId)}-${encodeShortId(branchId)}`)
    expect(name).toHaveLength(56)
    expect(name).toMatch(/^[a-z0-9-]+$/)
  })
})
