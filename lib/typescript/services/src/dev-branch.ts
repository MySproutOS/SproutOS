import { seal } from "@lib/envelope"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

import { postgresUri } from "./naming"
import { neonApi } from "./neon-api"
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
  /** What goes in the sandbox's `DATABASE_URL`. Points at pg-proxy, never at Neon. */
  uri: string
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
  },
): Promise<DevBranch> {
  const parent = await db
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
    .where("databaseBranch.kind", "=", "primary")
    .executeTakeFirst()

  if (parent === undefined || parent.providerProjectId === null) {
    throw new DevBranchUnavailableError(
      `backend service ${input.backendServiceId} has no active Neon primary branch to branch from`,
    )
  }

  const api = neonApi(config.neon)
  const created = await api.createBranch({
    projectId: parent.providerProjectId,
    name: `sandbox-${input.label}`,
    ...(parent.providerBranchId === null ? {} : { parentId: parent.providerBranchId }),
  })

  /*
    No connection URI means no endpoint, and no endpoint means a branch that exists in storage and
    cannot be connected to — which is a dev database that fails at the first query with an error
    about the host rather than about the branch. Neon is asked for a read-write endpoint by
    `createBranch`; if it did not give one, this is not usable and saying so here is the only place
    the cause is still visible.
  */
  if (created.connectionUri === undefined) {
    await api.deleteBranch(parent.providerProjectId, created.branch.id).catch(() => {
      // Best effort: the branch is unusable either way, and the reaper will find it. Failing here
      // would replace a clear error with a confusing one.
    })
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

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("databaseBranch")
      .values({
        id: branchId,
        databaseInstanceId: parent.instanceId,
        name: `sandbox-${input.label}`,
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
  })

  return {
    databaseBranchId: branchId,
    uri: postgresUri({
      host: config.publicHost,
      port: config.publicPort,
      // The database name the customer sees, which pg-proxy maps onto whatever Neon called it. The
      // same name as the primary, because from inside the sandbox this is the same database — a
      // different copy of it.
      database: `sprout_db_${input.backendServiceId.replaceAll("-", "").slice(-26)}`,
      username,
      password: secret,
      ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
    }),
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
    await neonApi(config.neon).deleteBranch(branch.providerProjectId, branch.providerBranchId)
  }

  await db.deleteFrom("databaseBranch").where("id", "=", branch.id).execute()
}

export class DevBranchUnavailableError extends Error {
  override readonly name = "DevBranchUnavailableError"
}
