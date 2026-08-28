import { seal } from "@lib/envelope"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

import { postgresUri } from "./naming"
import { NeonApiError, neonApi } from "./neon-api"
import { type NeonPostgresConfig, parseNeonUri } from "./neon-postgres"
import { rolePasswordContext } from "./postgres"
import { generateSecret, hashGeneratedSecret, lastFour, tenantUsername } from "./tenant-auth"

/**
 * An ephemeral database for a sandbox: a Neon branch, and a credential that can only reach it.
 *
 * ## Why this is not `provision`
 *
 * Provisioning creates a *database* — a Neon project, a primary branch, a customer's credential. A
 * sandbox needs none of that; it needs a copy of a database that already exists, which is what a
 * branch is. Neon branches are copy-on-write against the parent's pages, so this costs storage for
 * what the agent changes and nothing for what it reads, and it is instant regardless of size. That
 * property is the whole reason a coding agent can be given a real database at all: giving it the
 * production one is unthinkable, and restoring a dump per sandbox is minutes and money.
 *
 * ## The credential is the boundary, not the URI
 *
 * The sandbox gets a `db_…` username and a secret this platform issued, exactly like a customer's —
 * and the row carries `database_branch_id`, so `pg-proxy` will only ever connect it to this branch.
 * A credential taken out of a sandbox reaches the sandbox's copy and nothing else. Neon's own
 * password never leaves the control plane; it is sealed into `database_role` here the same way
 * provisioning seals the primary's.
 *
 * The username is shared with the service's primary credential on purpose: the proxy parses it for
 * *identity* — which service this is — and the wire protocol gives it nothing else to route on. Two
 * live credentials for one username are told apart by which secret verifies, which the Rust store
 * already does; the migration `sandbox_dev_branch` is what makes both able to exist.
 */
export type DevBranch = {
  databaseBranchId: string
  name: string
  /** What goes in the sandbox's `DATABASE_URL`. Points at pg-proxy, never at Neon. */
  uri: string
}

/** Conservative floor shared by every Neon tier the platform supports. */
export const DEFAULT_NEON_PROJECT_BRANCH_LIMIT = 10
/** One default branch plus four disposable alternatives per sandbox. */
export const MAX_SANDBOX_DATABASE_BRANCHES = 5

export function assertDevBranchQuota(input: {
  ownedBranches?: number
  maxOwnedBranches?: number
  providerBranches: number
  maxProjectBranches: number
}): void {
  if (
    input.ownedBranches !== undefined &&
    input.maxOwnedBranches !== undefined &&
    input.ownedBranches >= input.maxOwnedBranches
  ) {
    throw new DevBranchQuotaExceededError(
      `the sandbox already owns its maximum of ${input.maxOwnedBranches} database branches`,
    )
  }
  if (input.providerBranches >= input.maxProjectBranches) {
    throw new DevBranchQuotaExceededError(
      `the Neon project already has its maximum of ${input.maxProjectBranches} branches`,
    )
  }
}

export async function createDevBranch(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  input: {
    backendServiceId: string
    organizationId: string
    /** Appears in the Neon console, so it says which sandbox rather than which uuid. */
    label: string
    /** When the branch stops being worth keeping. Read by the branch reaper. */
    expiresAt?: Date
    /** Branch from the sandbox's current copy rather than from production. */
    parentDatabaseBranchId?: string
    /** Attach the branch to this sandbox so destroy/reap cannot lose ownership. */
    ownerSandboxId?: string
    /** Includes the sandbox's default branch. Required whenever ownerSandboxId is supplied. */
    maxOwnedBranches?: number
    /** Provider-wide safety cap, including branches not represented in this database. */
    maxProjectBranches?: number
  },
): Promise<DevBranch> {
  const api = neonApi(config.neon)
  let providerBranch: { projectId: string; branchId: string } | undefined
  try {
    return await db.transaction().execute(async (tx) => {
      if (input.ownerSandboxId !== undefined) {
        if (input.maxOwnedBranches === undefined || input.maxOwnedBranches < 1) {
          throw new TypeError("an owned dev branch requires a positive maxOwnedBranches")
        }
        const owner = await tx
          .selectFrom("sandbox")
          .select(["id", "state"])
          .where("id", "=", input.ownerSandboxId)
          .where("state", "!=", "deleting")
          .forUpdate()
          .executeTakeFirst()
        if (owner === undefined) {
          throw new DevBranchUnavailableError(
            `sandbox ${input.ownerSandboxId} is unavailable for a database branch`,
          )
        }
        const owned = await tx
          .selectFrom("sandboxDatabaseBranch")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("sandboxId", "=", owner.id)
          .executeTakeFirstOrThrow()
        assertDevBranchQuota({
          ownedBranches: Number(owned.count),
          maxOwnedBranches: input.maxOwnedBranches,
          providerBranches: 0,
          maxProjectBranches: Number.POSITIVE_INFINITY,
        })
      }

      let parentQuery = tx
        .selectFrom("databaseInstance")
        .innerJoin("databaseBranch", "databaseBranch.databaseInstanceId", "databaseInstance.id")
        .select([
          "databaseInstance.id as instanceId",
          "databaseInstance.providerProjectId as providerProjectId",
          "databaseBranch.id as branchId",
          "databaseBranch.providerBranchId as providerBranchId",
        ])
        .where("databaseInstance.backendServiceId", "=", input.backendServiceId)
        .where("databaseInstance.provider", "=", "neon")
        .where("databaseInstance.status", "=", "active")
        .forUpdate("databaseInstance")
      parentQuery =
        input.parentDatabaseBranchId === undefined
          ? parentQuery.where("databaseBranch.kind", "=", "primary")
          : parentQuery.where("databaseBranch.id", "=", input.parentDatabaseBranchId)
      const parent = await parentQuery.executeTakeFirst()

      if (parent === undefined || parent.providerProjectId === null) {
        throw new DevBranchUnavailableError(
          `backend service ${input.backendServiceId} has no requested active Neon branch to branch from`,
        )
      }

      const projectLimit = input.maxProjectBranches ?? DEFAULT_NEON_PROJECT_BRANCH_LIMIT
      const providerBranches = await api.listBranches(parent.providerProjectId)
      assertDevBranchQuota({
        providerBranches: providerBranches.length,
        maxProjectBranches: projectLimit,
      })

      const name = `sandbox-${input.label}`
      const duplicate = await tx
        .selectFrom("databaseBranch")
        .select("id")
        .where("databaseInstanceId", "=", parent.instanceId)
        .where("name", "=", name)
        .executeTakeFirst()
      if (duplicate !== undefined) {
        throw new DevBranchNameConflictError(`database branch ${name} already exists`)
      }
      const created = await api.createBranch({
        projectId: parent.providerProjectId,
        name,
        ...(parent.providerBranchId === null ? {} : { parentId: parent.providerBranchId }),
      })
      providerBranch = { projectId: parent.providerProjectId, branchId: created.branch.id }

      if (created.connectionUri === undefined) {
        throw new DevBranchUnavailableError(
          `Neon created branch ${created.branch.id} without an endpoint, so nothing can connect to it`,
        )
      }

      const neon = parseNeonUri(created.connectionUri)
      const secret = generateSecret()
      const branchId = v7()
      const roleId = v7()
      const sealed = await seal(neon.password, rolePasswordContext(roleId))
      const username = tenantUsername({
        organizationId: input.organizationId,
        kind: "database",
        resourceId: input.backendServiceId,
      })

      await tx
        .insertInto("databaseBranch")
        .values({
          id: branchId,
          databaseInstanceId: parent.instanceId,
          name,
          kind: "dev",
          parentBranchId: parent.branchId,
          providerBranchId: created.branch.id,
          host: neon.host,
          // Ephemeral by construction: an unprotected branch is what the reaper is allowed to delete,
          // and a dev branch nothing will ever delete is a bill with no owner.
          isProtected: false,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        })
        .execute()

      await tx
        .insertInto("databaseRole")
        .values({
          id: roleId,
          databaseBranchId: branchId,
          roleName: neon.role,
          passwordCiphertext: sealed.ciphertext,
          passwordWrappedDek: sealed.wrappedDek,
          passwordKmsKeyId: sealed.kmsKeyId,
        })
        .execute()

      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId: input.backendServiceId,
          databaseBranchId: branchId,
          username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        })
        .execute()

      if (input.ownerSandboxId !== undefined) {
        await tx
          .insertInto("sandboxDatabaseBranch")
          .values({ sandboxId: input.ownerSandboxId, databaseBranchId: branchId })
          .execute()
      }

      return {
        databaseBranchId: branchId,
        name,
        uri: postgresUri({
          host: config.publicHost,
          port: config.publicPort,
          database: `sprout_db_${input.backendServiceId.replaceAll("-", "").slice(-26)}`,
          username,
          password: secret,
          ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
        }),
      }
    })
  } catch (error) {
    if (providerBranch !== undefined) {
      try {
        await api.deleteBranch(providerBranch.projectId, providerBranch.branchId)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `creating the dev branch failed and provider branch ${providerBranch.branchId} could not be removed`,
          { cause: error },
        )
      }
    }
    throw error
  }
}

/**
 * Delete a sandbox's branch at Neon, and the row with it.
 *
 * The credential goes by cascade — `service_credential.database_branch_id` is `on delete cascade`
 * for exactly this, because a credential naming a branch that no longer exists is a live credential
 * resolving to nothing, which the proxy reports as an authentication failure.
 */
export async function dropDevBranch(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  databaseBranchId: string,
): Promise<void> {
  const branch = await db
    .selectFrom("databaseBranch")
    .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
    .select([
      "databaseBranch.id as id",
      "databaseBranch.providerBranchId as providerBranchId",
      "databaseBranch.isProtected as isProtected",
      "databaseInstance.providerProjectId as providerProjectId",
    ])
    .where("databaseBranch.id", "=", databaseBranchId)
    .executeTakeFirst()

  if (branch === undefined) return

  /*
    A protected branch is never deleted by this path, whatever it was asked to delete.

    `is_protected` is true for every primary. This function is called with an id read off a sandbox
    row, and the day something writes the wrong id there, the difference between a wasted call and a
    deleted production database is this check.
  */
  if (branch.isProtected) {
    throw new DevBranchUnavailableError(
      `branch ${databaseBranchId} is protected; only ephemeral branches are dropped here`,
    )
  }

  if (branch.providerBranchId !== null && branch.providerProjectId !== null) {
    try {
      await neonApi(config.neon).deleteBranch(branch.providerProjectId, branch.providerBranchId)
    } catch (error) {
      if (!(error instanceof NeonApiError && error.status === 404)) throw error
    }
  }

  await db.deleteFrom("databaseBranch").where("id", "=", branch.id).execute()
}

export class DevBranchUnavailableError extends Error {
  override readonly name = "DevBranchUnavailableError"
}

export class DevBranchQuotaExceededError extends Error {
  override readonly name = "DevBranchQuotaExceededError"
}

export class DevBranchNameConflictError extends Error {
  override readonly name = "DevBranchNameConflictError"
}
