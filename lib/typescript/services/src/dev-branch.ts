import { seal, type SealedValue } from "@lib/envelope"
import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"

import { databaseNameFor, postgresUri } from "./naming"
import { NeonApiError, neonApi } from "./neon-api"
import { type NeonPostgresConfig, parseNeonUri } from "./neon-postgres"
import { rolePasswordContext } from "./postgres"
import {
  encodeShortId,
  generateSecret,
  hashGeneratedSecret,
  lastFour,
  tenantUsername,
} from "./tenant-auth"

export type DevBranch = {
  databaseBranchId: string
  name: string
  /** What goes in the sandbox's `DATABASE_URL`. Points at pg-proxy, never at Neon. */
  uri: string
}

/** Conservative floor shared by every Neon tier the platform supports. */
export const DEFAULT_NEON_PROJECT_BRANCH_LIMIT = 10
/** Four disposable branches per sandbox; sandboxes no longer receive an automatic default. */
export const MAX_SANDBOX_DATABASE_BRANCHES = 4

const RESERVATION_TTL_MS = 10 * 60_000
const KMS_REQUEST_TIMEOUT_MS = 30_000

type DevBranchApi = Pick<
  ReturnType<typeof neonApi>,
  | "createBranch"
  | "deleteBranch"
  | "getConnectionUri"
  | "listBranches"
  | "listDatabases"
  | "listRoles"
>

export type DevBranchDependencies = {
  api: (config: NeonPostgresConfig["neon"]) => DevBranchApi
  hash: typeof hashGeneratedSecret
  id: () => string
  now: () => Date
  seal: (plaintext: string, context: ReturnType<typeof rolePasswordContext>) => Promise<SealedValue>
}

const defaultDependencies: DevBranchDependencies = {
  api: neonApi,
  hash: hashGeneratedSecret,
  id: v7,
  now: () => new Date(),
  seal: async (plaintext, context) =>
    await seal(plaintext, context, { abortSignal: AbortSignal.timeout(KMS_REQUEST_TIMEOUT_MS) }),
}

export type CreateDevBranchInput = {
  backendServiceId: string
  organizationId: string
  /** Human-readable suffix stored in SproutOS, never used as the provider identity. */
  label: string
  /** When the active branch stops being worth keeping. */
  expiresAt?: Date
  /** Branch from the sandbox's current copy rather than from production. */
  parentDatabaseBranchId?: string
  /** Agent branches have a durable sandbox owner before Neon is called. */
  ownerSandboxId?: string
  /** Persistent branches record the interactive user who created them. */
  createdByUserId?: string
  /** Persistent user branch or expiring agent branch. */
  kind?: "dev" | "user"
  /** Applies only to sandbox-owned branches. */
  maxOwnedBranches?: number
  /** Provider-wide safety cap, including resources not represented in this database. */
  maxProjectBranches?: number
}

type Reservation = {
  backendServiceId: string
  branchId: string
  databaseInstanceId: string
  databaseName: string
  dbBranchCount: number
  desiredExpiresAt: Date | null
  displayName: string
  organizationId: string
  parentProviderBranchId: string
  providerBranchName: string
  providerProjectId: string
  reservationToken: string
}

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

/** A full, collision-resistant provider identity that never contains customer input. */
export function devBranchProviderName(sandboxId: string, databaseBranchId: string): string {
  return `sb-${encodeShortId(sandboxId)}-${encodeShortId(databaseBranchId)}`
}

function exactProviderBranch(
  branches: Awaited<ReturnType<DevBranchApi["listBranches"]>>,
  name: string,
) {
  const matches = branches.filter((branch) => branch.name === name)
  if (matches.length > 1) {
    throw new DevBranchUnavailableError(`found multiple Neon branches named ${name}`)
  }
  return matches[0]
}

async function selfHealDefaultOwnership(
  tx: Transaction<DB>,
  sandbox: { id: string; databaseBranchId: string | null },
): Promise<void> {
  if (sandbox.databaseBranchId === null) return
  const branch = await tx
    .selectFrom("databaseBranch")
    .select("id")
    .where("id", "=", sandbox.databaseBranchId)
    .forUpdate()
    .executeTakeFirst()
  if (branch === undefined) {
    throw new DevBranchUnavailableError(
      `default branch ${sandbox.databaseBranchId} no longer exists`,
    )
  }
  const owner = await tx
    .selectFrom("sandboxDatabaseBranch")
    .select("sandboxId")
    .where("databaseBranchId", "=", sandbox.databaseBranchId)
    .executeTakeFirst()
  if (owner === undefined) {
    await tx
      .insertInto("sandboxDatabaseBranch")
      .values({ sandboxId: sandbox.id, databaseBranchId: sandbox.databaseBranchId })
      .execute()
    return
  }
  if (owner.sandboxId !== sandbox.id) {
    throw new DevBranchUnavailableError(
      `default branch ${sandbox.databaseBranchId} is already owned by another sandbox`,
    )
  }
}

async function reserveDevBranch(
  db: Kysely<DB>,
  input: CreateDevBranchInput,
  dependencies: DevBranchDependencies,
): Promise<Reservation> {
  const branchId = dependencies.id()
  const reservationToken = dependencies.id()
  const now = dependencies.now()
  const reservationExpiresAt = new Date(now.getTime() + RESERVATION_TTL_MS)
  const ownerId = input.ownerSandboxId ?? input.createdByUserId ?? input.organizationId
  const providerBranchName = devBranchProviderName(ownerId, branchId)
  const displayName =
    input.kind === "user"
      ? input.label
      : `sandbox-${encodeShortId(input.ownerSandboxId ?? ownerId)}-${input.label}`
  const projectLimit = input.maxProjectBranches ?? DEFAULT_NEON_PROJECT_BRANCH_LIMIT

  return await db.transaction().execute(async (tx) => {
    if (input.ownerSandboxId !== undefined) {
      const sandbox = await tx
        .selectFrom("sandbox")
        .select(["id", "state", "databaseBranchId"])
        .where("id", "=", input.ownerSandboxId)
        .where("state", "!=", "deleting")
        .forUpdate()
        .executeTakeFirst()
      if (sandbox === undefined) {
        throw new DevBranchUnavailableError(
          `sandbox ${input.ownerSandboxId} is unavailable for a database branch`,
        )
      }
      if (input.maxOwnedBranches === undefined || input.maxOwnedBranches < 1) {
        throw new TypeError("an owned dev branch requires a positive maxOwnedBranches")
      }
      await selfHealDefaultOwnership(tx, sandbox)
      const owned = await tx
        .selectFrom("sandboxDatabaseBranch")
        .innerJoin("databaseBranch", "databaseBranch.id", "sandboxDatabaseBranch.databaseBranchId")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("sandboxDatabaseBranch.sandboxId", "=", sandbox.id)
        .where("databaseBranch.deletedAt", "is", null)
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
      .where("databaseBranch.provisioningState", "=", "active")
      .where("databaseBranch.deletedAt", "is", null)
      .forUpdate("databaseInstance")
    parentQuery =
      input.parentDatabaseBranchId === undefined
        ? parentQuery.where("databaseBranch.kind", "=", "primary")
        : parentQuery.where("databaseBranch.id", "=", input.parentDatabaseBranchId)
    const parent = await parentQuery.executeTakeFirst()
    if (
      parent === undefined ||
      parent.providerProjectId === null ||
      parent.providerBranchId === null
    ) {
      throw new DevBranchUnavailableError(
        `backend service ${input.backendServiceId} has no requested active Neon branch to branch from`,
      )
    }

    const branchCount = await tx
      .selectFrom("databaseBranch")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("databaseInstanceId", "=", parent.instanceId)
      .where("deletedAt", "is", null)
      .executeTakeFirstOrThrow()
    assertDevBranchQuota({
      providerBranches: Number(branchCount.count),
      maxProjectBranches: projectLimit,
    })

    const duplicate = await tx
      .selectFrom("databaseBranch")
      .select("id")
      .where("databaseInstanceId", "=", parent.instanceId)
      .where("name", "=", displayName)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
    if (duplicate !== undefined) {
      throw new DevBranchNameConflictError(`database branch ${displayName} already exists`)
    }

    await tx
      .insertInto("databaseBranch")
      .values({
        id: branchId,
        databaseInstanceId: parent.instanceId,
        name: displayName,
        providerBranchName,
        kind: input.kind ?? "dev",
        createdByUserId: input.createdByUserId,
        parentBranchId: parent.branchId,
        isProtected: false,
        expiresAt: reservationExpiresAt,
        provisioningState: "provisioning",
        reservationToken,
      })
      .execute()
    if (input.ownerSandboxId !== undefined) {
      await tx
        .insertInto("sandboxDatabaseBranch")
        .values({ sandboxId: input.ownerSandboxId, databaseBranchId: branchId })
        .execute()
    }

    return {
      backendServiceId: input.backendServiceId,
      branchId,
      databaseInstanceId: parent.instanceId,
      databaseName: databaseNameFor(input.backendServiceId),
      dbBranchCount: Number(branchCount.count) + 1,
      desiredExpiresAt: input.expiresAt ?? null,
      displayName,
      organizationId: input.organizationId,
      parentProviderBranchId: parent.providerBranchId,
      providerBranchName,
      providerProjectId: parent.providerProjectId,
      reservationToken,
    }
  })
}

async function connectionUriForBranch(
  api: DevBranchApi,
  reservation: Reservation,
  branchId: string,
): Promise<string> {
  const [databases, roles] = await Promise.all([
    api.listDatabases(reservation.providerProjectId, branchId),
    api.listRoles(reservation.providerProjectId, branchId),
  ])
  const usable = databases.filter((database) =>
    roles.some((role) => role.name === database.owner_name),
  )
  if (usable.length !== 1) {
    throw new DevBranchUnavailableError(
      `expected one owned database on Neon branch ${branchId}; found ${usable.length}`,
    )
  }
  return await api.getConnectionUri({
    projectId: reservation.providerProjectId,
    branchId,
    database: usable[0].name,
    role: usable[0].owner_name,
  })
}

async function markProviderIdentity(
  db: Kysely<DB>,
  reservation: Reservation,
  providerBranchId: string,
): Promise<void> {
  const updated = await db
    .updateTable("databaseBranch")
    .set({ providerBranchId, updatedAt: new Date() })
    .where("id", "=", reservation.branchId)
    .where("provisioningState", "=", "provisioning")
    .where("reservationToken", "=", reservation.reservationToken)
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows) !== 1) {
    throw new DevBranchReservationLostError(reservation.branchId)
  }
}

async function markReservationForCleanup(
  db: Kysely<DB>,
  reservation: Reservation,
  error: unknown,
): Promise<void> {
  await db
    .updateTable("databaseBranch")
    .set({
      provisioningState: "cleanup",
      expiresAt: new Date(),
      cleanupError: String(error).slice(0, 2_000),
      cleanupRetryAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", reservation.branchId)
    .where("reservationToken", "=", reservation.reservationToken)
    .where("provisioningState", "in", ["provisioning", "cleanup"])
    .execute()
}

async function finalizeReservation(
  db: Kysely<DB>,
  reservation: Reservation,
  input: {
    providerBranchId: string
    host: string
    roleId: string
    roleName: string
    sealed: SealedValue
    secret: string
    secretHash: string
  },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const finalized = await tx
      .updateTable("databaseBranch")
      .set({
        providerBranchId: input.providerBranchId,
        host: input.host,
        expiresAt: reservation.desiredExpiresAt,
        provisioningState: "active",
        reservationToken: null,
        cleanupAttempts: 0,
        cleanupRetryAt: null,
        cleanupError: null,
        updatedAt: new Date(),
      })
      .where("id", "=", reservation.branchId)
      .where("providerBranchId", "=", input.providerBranchId)
      .where("provisioningState", "=", "provisioning")
      .where("reservationToken", "=", reservation.reservationToken)
      .returning("id")
      .executeTakeFirst()
    if (finalized === undefined) throw new DevBranchReservationLostError(reservation.branchId)

    await tx
      .insertInto("databaseRole")
      .values({
        id: input.roleId,
        databaseBranchId: reservation.branchId,
        roleName: input.roleName,
        passwordCiphertext: input.sealed.ciphertext,
        passwordWrappedDek: input.sealed.wrappedDek,
        passwordKmsKeyId: input.sealed.kmsKeyId,
      })
      .execute()
    await tx
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: reservation.backendServiceId,
        databaseBranchId: reservation.branchId,
        username: tenantUsername({
          organizationId: reservation.organizationId,
          kind: "database",
          resourceId: reservation.backendServiceId,
        }),
        secretHash: input.secretHash,
        lastFour: lastFour(input.secret),
        ...(reservation.desiredExpiresAt === null
          ? {}
          : { expiresAt: reservation.desiredExpiresAt }),
      })
      .execute()
  })
}

async function cleanFailedReservation(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  reservation: Reservation,
  error: unknown,
  dependencies: DevBranchDependencies,
): Promise<never> {
  await markReservationForCleanup(db, reservation, error)
  try {
    // Clean by the deterministic provider identity rather than relying on another read of the
    // reservation row. A concurrent owner/database teardown may cascade that row after Neon
    // accepted the create; its disappearance must not turn an ambiguous success into an
    // unrecorded resource.
    await deleteProviderBranchByIdentity(
      dependencies.api(config.neon),
      reservation.providerProjectId,
      reservation.providerBranchName,
      reservation.parentProviderBranchId,
    )
    const now = dependencies.now()
    await db.transaction().execute(async (tx) => {
      const tracked = await tx
        .selectFrom("databaseBranch")
        .select("providerBranchId")
        .where("id", "=", reservation.branchId)
        .where("reservationToken", "=", reservation.reservationToken)
        .where("provisioningState", "=", "cleanup")
        .forUpdate()
        .executeTakeFirst()
      if (tracked?.providerBranchId === null) {
        await tx.deleteFrom("databaseBranch").where("id", "=", reservation.branchId).execute()
      } else if (tracked !== undefined) {
        // A provider branch existed, even if credential setup failed. Preserve its identity and
        // lifetime so the per-branch consumption job can close its final metering window.
        await tx
          .updateTable("databaseBranch")
          .set({
            provisioningState: "deleted",
            reservationToken: null,
            expiresAt: null,
            deletedAt: now,
            cleanupRetryAt: null,
            cleanupError: null,
            updatedAt: now,
          })
          .where("id", "=", reservation.branchId)
          .execute()
      }
    })
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `dev branch ${reservation.branchId} failed and remains durably reserved for cleanup`,
      { cause: error },
    )
  }
  throw error
}

async function deleteProviderBranchByIdentity(
  api: DevBranchApi,
  providerProjectId: string,
  providerBranchName: string,
  expectedParentId?: string,
  recordedProviderBranchId?: string | null,
): Promise<void> {
  const providerBranches = await api.listBranches(providerProjectId)
  const byName = exactProviderBranch(providerBranches, providerBranchName)
  const byId =
    recordedProviderBranchId === undefined || recordedProviderBranchId === null
      ? undefined
      : providerBranches.find(({ id }) => id === recordedProviderBranchId)

  if (byId !== undefined && byId.name !== providerBranchName) {
    throw new DevBranchUnavailableError(
      `provider id ${recordedProviderBranchId} no longer has expected name ${providerBranchName}`,
    )
  }
  const branch = byId ?? byName
  if (branch === undefined) return
  if (expectedParentId !== undefined && branch.parent_id !== expectedParentId) {
    throw new DevBranchUnavailableError(
      `refusing Neon branch ${branch.id} with an unexpected parent`,
    )
  }

  try {
    await api.deleteBranch(providerProjectId, branch.id)
  } catch (error) {
    if (!(error instanceof NeonApiError && error.status === 404)) {
      const stillExists = (await api.listBranches(providerProjectId)).some(
        ({ id, name }) => id === branch.id || name === providerBranchName,
      )
      if (stillExists) throw error
    }
  }
}

/**
 * Reserve locally, call Neon/KMS without holding a connection, then finalize by CAS.
 *
 * The reservation is the crash boundary. A timeout after Neon accepted `createBranch` cannot leave
 * an unnamed provider resource: the provider name contains both full UUID identities, and the row
 * remains until a list/adopt or cleanup pass proves that exact name absent.
 */
export async function createDevBranch(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  input: CreateDevBranchInput,
  dependencies: Partial<DevBranchDependencies> = {},
): Promise<DevBranch> {
  const deps = { ...defaultDependencies, ...dependencies }
  const reservation = await reserveDevBranch(db, input, deps)
  const api = deps.api(config.neon)

  try {
    let branches = await api.listBranches(reservation.providerProjectId)
    const tracked = new Set(
      (
        await db
          .selectFrom("databaseBranch")
          .select("providerBranchId")
          .where("databaseInstanceId", "=", reservation.databaseInstanceId)
          .where("providerBranchId", "is not", null)
          .execute()
      ).map((branch) => branch.providerBranchId!),
    )
    const untrackedProviderBranches = branches.filter((branch) => !tracked.has(branch.id)).length
    assertDevBranchQuota({
      providerBranches: reservation.dbBranchCount + untrackedProviderBranches - 1,
      maxProjectBranches: input.maxProjectBranches ?? DEFAULT_NEON_PROJECT_BRANCH_LIMIT,
    })

    let providerBranch = exactProviderBranch(branches, reservation.providerBranchName)
    let connectionUri: string | undefined
    if (providerBranch === undefined) {
      try {
        const created = await api.createBranch({
          projectId: reservation.providerProjectId,
          name: reservation.providerBranchName,
          parentId: reservation.parentProviderBranchId,
        })
        providerBranch = created.branch
        connectionUri = created.connectionUri
      } catch (createError) {
        // POST may have succeeded before the response timed out. The full deterministic name is
        // the idempotency key Neon does not offer, so list and adopt before considering cleanup.
        try {
          branches = await api.listBranches(reservation.providerProjectId)
        } catch (reconcileError) {
          throw new AggregateError(
            [createError, reconcileError],
            `Neon create outcome is ambiguous for ${reservation.providerBranchName}`,
            { cause: createError },
          )
        }
        providerBranch = exactProviderBranch(branches, reservation.providerBranchName)
        if (providerBranch === undefined) throw createError
      }
    }
    if (
      providerBranch.name !== reservation.providerBranchName ||
      providerBranch.parent_id !== reservation.parentProviderBranchId
    ) {
      throw new DevBranchUnavailableError(
        `refusing Neon branch ${providerBranch.id} with an unexpected identity or parent`,
      )
    }

    await markProviderIdentity(db, reservation, providerBranch.id)
    connectionUri ??= await connectionUriForBranch(api, reservation, providerBranch.id)
    const neon = parseNeonUri(connectionUri)
    const secret = generateSecret()
    const roleId = deps.id()
    const [sealed, secretHash] = await Promise.all([
      deps.seal(neon.password, rolePasswordContext(roleId)),
      deps.hash(secret),
    ])
    await finalizeReservation(db, reservation, {
      providerBranchId: providerBranch.id,
      host: neon.host,
      roleId,
      roleName: neon.role,
      sealed,
      secret,
      secretHash,
    })

    return {
      databaseBranchId: reservation.branchId,
      name: reservation.displayName,
      uri: postgresUri({
        host: config.publicHost,
        port: config.publicPort,
        database: reservation.databaseName,
        username: tenantUsername({
          organizationId: reservation.organizationId,
          kind: "database",
          resourceId: reservation.backendServiceId,
        }),
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  } catch (error) {
    return await cleanFailedReservation(db, config, reservation, error, deps)
  }
}

/** Delete provider state first; remove the durable reservation only after absence is confirmed. */
export async function dropDevBranch(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  databaseBranchId: string,
  dependencies: Partial<DevBranchDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies }
  const branch = await db
    .selectFrom("databaseBranch")
    .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
    .select([
      "databaseBranch.id as id",
      "databaseBranch.providerBranchId as providerBranchId",
      "databaseBranch.providerBranchName as providerBranchName",
      "databaseBranch.name as name",
      "databaseBranch.provisioningState as provisioningState",
      "databaseBranch.expiresAt as expiresAt",
      "databaseBranch.isProtected as isProtected",
      "databaseBranch.deletedAt as deletedAt",
      "databaseInstance.providerProjectId as providerProjectId",
    ])
    .where("databaseBranch.id", "=", databaseBranchId)
    .executeTakeFirst()
  if (branch === undefined) return
  if (branch.deletedAt !== null) return
  if (branch.isProtected) {
    throw new DevBranchUnavailableError(
      `branch ${databaseBranchId} is protected; only ephemeral branches are dropped here`,
    )
  }
  if (
    branch.provisioningState === "provisioning" &&
    branch.expiresAt !== null &&
    branch.expiresAt > deps.now()
  ) {
    throw new DevBranchUnavailableError(`branch ${databaseBranchId} is still being provisioned`)
  }

  const child = await db
    .selectFrom("databaseBranch")
    .select("id")
    .where("parentBranchId", "=", branch.id)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (child !== undefined) {
    throw new DevBranchHasChildrenError(`branch ${databaseBranchId} still has active children`)
  }

  if (branch.providerProjectId !== null) {
    const api = deps.api(config.neon)
    const providerBranchName = branch.providerBranchName ?? branch.name
    await deleteProviderBranchByIdentity(
      api,
      branch.providerProjectId,
      providerBranchName,
      undefined,
      branch.providerBranchId,
    )
  }

  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("databaseRole").where("databaseBranchId", "=", branch.id).execute()
    await tx
      .updateTable("serviceCredential")
      .set({ revokedAt: deps.now() })
      .where("databaseBranchId", "=", branch.id)
      .where("revokedAt", "is", null)
      .execute()
    await tx
      .updateTable("databaseBranch")
      .set({
        deletedAt: deps.now(),
        expiresAt: null,
        provisioningState: "deleted",
        cleanupRetryAt: null,
        cleanupError: null,
        reservationToken: null,
        updatedAt: deps.now(),
      })
      .where("id", "=", branch.id)
      .execute()
  })
}

export async function rotateDevBranchCredential(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  input: { databaseBranchId: string; organizationId: string },
): Promise<string> {
  const branch = await db
    .selectFrom("databaseBranch")
    .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
    .select(["databaseInstance.backendServiceId", "databaseBranch.provisioningState"])
    .where("databaseBranch.id", "=", input.databaseBranchId)
    .where("databaseBranch.deletedAt", "is", null)
    .executeTakeFirst()
  if (branch === undefined || branch.provisioningState !== "active") {
    throw new DevBranchUnavailableError(`branch ${input.databaseBranchId} is not active`)
  }

  const secret = generateSecret()
  const username = tenantUsername({
    organizationId: input.organizationId,
    kind: "database",
    resourceId: branch.backendServiceId,
  })
  const secretHash = await hashGeneratedSecret(secret)
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("databaseBranchId", "=", input.databaseBranchId)
      .where("revokedAt", "is", null)
      .execute()
    await tx
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: branch.backendServiceId,
        databaseBranchId: input.databaseBranchId,
        username,
        secretHash,
        lastFour: lastFour(secret),
      })
      .execute()
  })

  return postgresUri({
    host: config.publicHost,
    port: config.publicPort,
    database: databaseNameFor(branch.backendServiceId),
    username,
    password: secret,
    ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
  })
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

export class DevBranchHasChildrenError extends Error {
  override readonly name = "DevBranchHasChildrenError"
}

export class DevBranchReservationLostError extends Error {
  override readonly name = "DevBranchReservationLostError"

  constructor(databaseBranchId: string) {
    super(`database branch reservation ${databaseBranchId} changed before it could finalize`)
  }
}
