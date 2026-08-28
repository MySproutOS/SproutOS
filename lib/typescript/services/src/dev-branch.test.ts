import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { Client } from "pg"

import {
  assertDevBranchQuota,
  createDevBranch,
  DevBranchQuotaExceededError,
  DevBranchUnavailableError,
  dropDevBranch,
  MAX_SANDBOX_DATABASE_BRANCHES,
} from "./dev-branch"
import { neonApi, neonApiConfigFromEnv } from "./neon-api"
import { neonPostgresConfigFromEnv, parseNeonUri } from "./neon-postgres"
import { rolePasswordContext } from "./postgres"
import { databaseNameFor } from "./naming"

/**
 * A sandbox's dev database, against real Neon and a real control plane.
 *
 * The properties worth asserting are all about the seam: that the branch exists at the provider,
 * that the credential the sandbox gets reaches *that* branch, and that the URI it goes into names
 * pg-proxy rather than Neon. None of it is observable from a mock, and all of it is what stands
 * between an agent's dev database and a customer's production one.
 *
 * One Neon project, created and deleted. The organization is on the Free plan, so a leaked project
 * is a quota nobody can spend.
 */
const config = (() => {
  try {
    return { neon: neonApiConfigFromEnv(), postgres: neonPostgresConfigFromEnv() }
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config === undefined) return false
  try {
    await sql`select 1`.execute(db)
    // Sealing needs KMS, which is LocalStack here. A dev branch stores Neon's password sealed, so
    // without it this cannot run at all — and skipping is better than a failure that reads as Neon.
    const { seal } = await import("@lib/envelope")
    await seal("probe", rolePasswordContext(v7()))
    await neonApi(config.neon).listProjects()
    return true
  } catch {
    return false
  }
})()

const neonProjects: string[] = []
const organizationId = v7()
const userId = v7()
const repositoryId = v7()
const projectId = v7()
const backendServiceId = v7()
const instanceId = v7()
const primaryBranchId = v7()
const sandboxId = v7()

describe("dev branch quotas", () => {
  it("refuses at both the per-sandbox and provider-wide boundary", () => {
    expect(() => {
      assertDevBranchQuota({
        ownedBranches: 5,
        maxOwnedBranches: 5,
        providerBranches: 5,
        maxProjectBranches: 10,
      })
    }).toThrow(DevBranchQuotaExceededError)
    expect(() => {
      assertDevBranchQuota({ providerBranches: 10, maxProjectBranches: 10 })
    }).toThrow(DevBranchQuotaExceededError)
    expect(() => {
      assertDevBranchQuota({
        ownedBranches: 4,
        maxOwnedBranches: 5,
        providerBranches: 9,
        maxProjectBranches: 10,
      })
    }).not.toThrow()
  })
})

afterAll(async () => {
  if (!reachable) return
  for (const id of neonProjects) {
    await neonApi(config!.neon)
      .deleteProject(id)
      .catch(() => undefined)
  }
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("serviceCredential")
      .where("backendServiceId", "=", backendServiceId)
      .execute()
    await tx.deleteFrom("sandbox").where("id", "=", sandboxId).execute()
    await tx.deleteFrom("databaseRole").execute()
    await tx.deleteFrom("databaseBranch").where("databaseInstanceId", "=", instanceId).execute()
    await tx.deleteFrom("databaseInstance").where("id", "=", instanceId).execute()
    await tx.deleteFrom("backendService").where("id", "=", backendServiceId).execute()
    await tx.deleteFrom("project").where("id", "=", projectId).execute()
    await tx.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
}, 300_000)

describe.runIf(reachable)("a sandbox's dev database", () => {
  it("branches the customer's database and issues a credential that can only reach the branch", async () => {
    const { seal } = await import("@lib/envelope")
    const api = neonApi(config!.neon)

    // A customer database, as `provision` would have left it.
    const { project, branch, connectionUri } = await api.createProject({
      name: `sproutos-devbranch-${Date.now()}`,
      minCu: 0.25,
      maxCu: 1,
    })
    neonProjects.push(project.id)
    const neon = parseNeonUri(connectionUri)
    const roleId = v7()
    const sealed = await seal(neon.password, rolePasswordContext(roleId))

    await db
      .insertInto("user")
      .values({ id: userId, email: `dev-${userId}@test.invalid`, name: "Dev" })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Dev Branch Org",
        slug: `dev-branch-${organizationId.slice(-12)}`,
        kind: "personal",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
        ownerLogin: "dev-branch",
        name: `repo-${repositoryId.slice(-12)}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Dev",
        slug: `dev-${projectId.slice(-12)}`,
      })
      .execute()
    const region = await db
      .selectFrom("region")
      .select(["id"])
      .where("isActive", "=", true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto("backendService")
      .values({
        id: backendServiceId,
        projectId,
        organizationId,
        regionId: region.id,
        name: "dev-branch-db",
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
        providerProjectId: project.id,
        region: project.region_id,
        status: "active",
      })
      .execute()
    await db
      .insertInto("databaseBranch")
      .values({
        id: primaryBranchId,
        databaseInstanceId: instanceId,
        name: "main",
        kind: "primary",
        providerBranchId: branch.id,
        host: neon.host,
        isProtected: true,
      })
      .execute()
    await db
      .insertInto("databaseRole")
      .values({
        id: roleId,
        databaseBranchId: primaryBranchId,
        roleName: neon.role,
        passwordCiphertext: sealed.ciphertext,
        passwordWrappedDek: sealed.wrappedDek,
        passwordKmsKeyId: sealed.kmsKeyId,
      })
      .execute()
    await db
      .insertInto("sandbox")
      .values({ id: sandboxId, projectId, userId, state: "starting" })
      .execute()

    const dev = await createDevBranch(db, config!.postgres, {
      backendServiceId,
      organizationId,
      label: "sbx-test",
      ownerSandboxId: sandboxId,
      maxOwnedBranches: MAX_SANDBOX_DATABASE_BRANCHES,
    })

    // The URI a sandbox is given names pg-proxy. A Neon host here would be a credential that works
    // against Neon directly and skips every check this platform makes.
    expect(dev.uri).toContain(config!.postgres.publicHost)
    expect(dev.uri).not.toContain(neon.host)
    expect(dev.uri).not.toContain(neon.password)
    expect(new URL(dev.uri).pathname).toBe(`/${databaseNameFor(backendServiceId)}`)

    const client = new Client({ connectionString: dev.uri, connectionTimeoutMillis: 15_000 })
    await client.connect()
    try {
      const connected = await client.query<{ database: string }>(
        "select current_database() as database",
      )
      expect(connected.rows[0]?.database).toBe(neon.database)
    } finally {
      await client.end()
    }

    const row = await db
      .selectFrom("databaseBranch")
      .select(["kind", "isProtected", "parentBranchId", "providerBranchId", "host"])
      .where("id", "=", dev.databaseBranchId)
      .executeTakeFirstOrThrow()
    expect(row.kind).toBe("dev")
    // Unprotected, or the reaper is not allowed to delete it and the branch bills forever.
    expect(row.isProtected).toBe(false)
    expect(row.parentBranchId).toBe(primaryBranchId)

    // It exists at Neon, with an endpoint — a branch with none is storage nothing can connect to.
    const branches = await api.listBranches(project.id)
    expect(branches.map((it) => it.id)).toContain(row.providerBranchId)
    expect(row.host).not.toBe(neon.host)

    /*
      Two live credentials for one username, told apart by their secret.

      The username is derived from the service, so the sandbox's credential shares it with the
      customer's — which is what the Rust store expects, and what the live index forbade until the
      `sandbox_dev_branch` migration. What separates them is the branch on the row.
    */
    const credentials = await db
      .selectFrom("serviceCredential")
      .select(["username", "databaseBranchId", "purpose"])
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()
    const branchScoped = credentials.filter((it) => it.databaseBranchId === dev.databaseBranchId)
    expect(branchScoped.length).toBe(1)
    expect(dev.uri).toContain(encodeURIComponent(branchScoped[0].username))

    // Dropping takes the branch at Neon and the credential with it: a credential naming a branch
    // that is gone is a live credential resolving to nothing, which the proxy reports as a bad
    // password.
    await dropDevBranch(db, config!.postgres, dev.databaseBranchId)
    expect((await api.listBranches(project.id)).map((it) => it.id)).not.toContain(
      row.providerBranchId,
    )
    const after = await db
      .selectFrom("serviceCredential")
      .select(["id"])
      .where("databaseBranchId", "=", dev.databaseBranchId)
      .execute()
    expect(after).toEqual([])
  }, 600_000)

  it("refuses to drop a protected branch", async () => {
    /*
      The id comes off a sandbox row. The day something writes the wrong one there, this check is
      the difference between a wasted call and a deleted production database — so it is asserted
      rather than assumed, and the primary is the branch it is asserted against.
    */
    await expect(dropDevBranch(db, config!.postgres, primaryBranchId)).rejects.toBeInstanceOf(
      DevBranchUnavailableError,
    )
  }, 60_000)
})
