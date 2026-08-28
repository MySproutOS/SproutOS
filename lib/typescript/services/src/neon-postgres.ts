import type { DB } from "@sproutos/db"
import { seal } from "@lib/envelope"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import { NeonApiError, neonApi, neonApiConfigFromEnv, type NeonConfig } from "./neon-api"
import { postgresUri } from "./naming"
import { rolePasswordContext } from "./postgres"
import { generateSecret, hashGeneratedSecret, lastFour, tenantUsername } from "./tenant-auth"
import {
  ServiceNotProvisionedError,
  type ConnectionDetails,
  type CredentialOwner,
  type ProvisionInput,
  type ProvisionResult,
  type ServiceDriver,
} from "./types"
import { SecretNotRecoverableError } from "./valkey"

/**
 * Postgres on Neon: `database_instance.provider = 'neon'`.
 *
 * One Neon project per customer database. Neon owns the storage, the compute, and the wake-on-
 * connect that makes an idle database free — see ADR 0025 for why that beat running it ourselves.
 *
 * ## What this driver is responsible for, and what it is not
 *
 * It is responsible for the mapping: a SproutOS `backend_service` to a Neon project, a
 * `database_branch` to a Neon branch, and a customer-facing credential that is **not** Neon's.
 *
 * It is not responsible for compute. There is no endpoint to start, no address to track, no admin
 * password to hold. Provision creates a project and returns; the first connection wakes it, and
 * Neon does that.
 *
 * ## The customer never holds a Neon credential
 *
 * Same boundary as object storage, and the same reason. The customer gets a `db_…` username and a
 * secret this platform issued, stored as a one-way hash, verified by `pg-proxy`. Neon's own
 * connection string — which is a real credential to a real database, outside our tenancy model —
 * is sealed under KMS in `database_role` and only `pg-proxy` ever opens it.
 */

export type NeonPostgresConfig = {
  neon: NeonConfig
  /** What goes in a customer's URI: `pg-proxy`, never a Neon host. */
  publicHost: string
  publicPort: number
  sslmode?: string
}

export function neonPostgresConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NeonPostgresConfig {
  const publicHost = env.SERVICE_POSTGRES_PUBLIC_HOST
  if (publicHost === undefined || publicHost === "") {
    throw new Error(
      "SERVICE_POSTGRES_PUBLIC_HOST is not set. It is the address of pg-proxy, which is the only " +
        "thing a customer is given — a URI naming a Neon host would hand out a credential that " +
        "works against Neon directly and bypasses every check this platform makes.",
    )
  }

  return {
    neon: neonApiConfigFromEnv(env),
    publicHost,
    publicPort: Number(env.SERVICE_POSTGRES_PUBLIC_PORT ?? 5432),
    ...(env.SERVICE_POSTGRES_SSLMODE === undefined
      ? {}
      : { sslmode: env.SERVICE_POSTGRES_SSLMODE }),
  }
}

/**
 * The parts of a Neon connection string the control plane stores.
 *
 * Neon returns it once, at creation, and never again — losing it means resetting the role's
 * password. It is taken apart rather than stored whole so that the password lands in the sealed
 * column `database_role` already has, and the host in the column `database_branch` already has,
 * which is what those columns were named for in the first migration.
 */
export function parseNeonUri(uri: string): {
  host: string
  database: string
  role: string
  password: string
} {
  const url = new URL(uri)
  return {
    host: url.host,
    // `/dbname` — Neon's default is `neondb`.
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    role: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

type NeonProvisionApi = Pick<
  ReturnType<typeof neonApi>,
  "listProjects" | "listBranches" | "listDatabases" | "listRoles" | "getConnectionUri"
>

/** Locate only the exact provider identity and read all material needed to adopt it. */
export async function reconcileNeonProvision(
  api: NeonProvisionApi,
  backendServiceId: string,
): Promise<{
  project: { id: string; name: string; region_id: string }
  branch: { id: string }
  connectionUri: string
}> {
  const currentName = `sproutos-${backendServiceId}`
  const legacyName = `sproutos-${backendServiceId.slice(0, 8)}`
  const current = (await api.listProjects(currentName)).filter(({ name }) => name === currentName)
  const candidates =
    current.length === 0
      ? (await api.listProjects(legacyName)).filter(({ name }) => name === legacyName)
      : current
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Neon project for backend service ${backendServiceId}; found ${candidates.length}`,
    )
  }
  const project = candidates[0]
  const branches = (await api.listBranches(project.id)).filter(
    ({ name, primary, default: isDefault }) =>
      name === "main" && (primary === true || isDefault === true),
  )
  if (branches.length !== 1) {
    throw new Error(`Expected exactly one primary Neon branch for project ${project.id}`)
  }
  const branch = branches[0]
  const [databases, roles] = await Promise.all([
    api.listDatabases(project.id, branch.id),
    api.listRoles(project.id, branch.id),
  ])
  const usable = databases.filter((database) =>
    roles.some((role) => role.name === database.owner_name),
  )
  if (usable.length !== 1) {
    throw new Error(`Expected exactly one owned Neon database for project ${project.id}`)
  }
  const database = usable[0]
  const connectionUri = await api.getConnectionUri({
    projectId: project.id,
    branchId: branch.id,
    database: database.name,
    role: database.owner_name,
  })
  return { project, branch, connectionUri }
}

export function neonPostgresDriver(db: Kysely<DB>, config: NeonPostgresConfig): ServiceDriver {
  const api = neonApi(config.neon)

  async function locate(backendServiceId: string) {
    const service = await db
      .selectFrom("backendService")
      .innerJoin("databaseInstance", "databaseInstance.backendServiceId", "backendService.id")
      .select(["backendService.organizationId as organizationId"])
      .where("backendService.id", "=", backendServiceId)
      .where("databaseInstance.provider", "=", "neon")
      .where("databaseInstance.deletedAt", "is", null)
      .executeTakeFirst()
    if (service === undefined) throw new ServiceNotProvisionedError(backendServiceId)
    return service
  }

  function detailsFor(input: {
    backendServiceId: string
    organizationId: string
  }): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      // The database name a customer sees is ours, not Neon's. `pg-proxy` maps it to whatever Neon
      // called the database, so a Neon default of `neondb` never leaks into a customer's URI.
      database: `sprout_db_${input.backendServiceId.replaceAll("-", "").slice(-26)}`,
      username: tenantUsername({
        organizationId: input.organizationId,
        kind: "database",
        resourceId: input.backendServiceId,
      }),
    }
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const details = detailsFor(input)

    /*
      Neon first, database second.

      If the transaction below fails, a Neon project is orphaned — which `destroy` and a reaper can
      both clean up. The other order leaves a `database_instance` row pointing at a project that was
      never created: a database the customer can see and nothing can serve.
    */
    const { project, branch, connectionUri } = await api.createProject({
      name: `sproutos-${input.backendServiceId}`,
      // Below 1 CU so an idle customer database costs storage and no compute. This is the entire
      // economic argument for Neon over a Postgres that is always running.
      minCu: 0.25,
      maxCu: 2,
    })

    const neon = parseNeonUri(connectionUri)
    const secret = generateSecret()
    const roleId = v7()
    const sealed = await seal(neon.password, rolePasswordContext(roleId))

    await db.transaction().execute(async (tx) => {
      const instanceId = v7()
      const branchId = v7()

      await tx
        .insertInto("databaseInstance")
        .values({
          id: instanceId,
          backendServiceId: input.backendServiceId,
          projectId: input.projectId,
          provider: "neon",
          providerProjectId: project.id,
          region: project.region_id,
          status: "active",
        })
        .execute()

      await tx
        .insertInto("databaseBranch")
        .values({
          id: branchId,
          databaseInstanceId: instanceId,
          name: "main",
          kind: "primary",
          providerBranchId: branch.id,
          // Neon's host, which is where `pg-proxy` connects — never what the customer is told.
          host: neon.host,
          isProtected: true,
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

      /*
        The customer's own secret, separate from Neon's password.

        Two credentials, deliberately. Neon's is how `pg-proxy` reaches the database and is sealed
        under KMS; the one below is what the customer sends, is stored as a one-way hash, and is the
        only thing the proxy verifies. A customer holding Neon's password would hold a credential
        that works against Neon directly and skips every check this platform makes.
      */
      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId: input.backendServiceId,
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
          oauthGrantId: input.credentialOwner?.oauthGrantId ?? null,
        })
        .execute()
    })

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()

    return {
      ...details,
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  async function recoverProvision(input: ProvisionInput): Promise<ProvisionResult> {
    try {
      const service = await locate(input.backendServiceId)
      const details = detailsFor({
        backendServiceId: input.backendServiceId,
        organizationId: service.organizationId,
      })
      return {
        ...details,
        ...(await rotateCredentials(input.backendServiceId, input.credentialOwner)),
      }
    } catch (error) {
      if (!(error instanceof ServiceNotProvisionedError)) throw error
    }

    const adopted = await reconcileNeonProvision(api, input.backendServiceId)
    if (adopted.project.name === `sproutos-${input.backendServiceId.slice(0, 8)}`) {
      const sameLegacyIdentity = await db
        .selectFrom("backendService")
        .select("id")
        .where(sql<boolean>`left(id::text, 8) = ${input.backendServiceId.slice(0, 8)}`)
        .execute()
      if (sameLegacyIdentity.length !== 1 || sameLegacyIdentity[0]?.id !== input.backendServiceId) {
        throw new Error(
          `Legacy Neon identity for ${input.backendServiceId} is not unique in the control plane`,
        )
      }
    }
    if (adopted.project.region_id !== config.neon.regionId) {
      throw new Error(`Refusing to adopt Neon project ${adopted.project.id} from another region`)
    }
    const alreadyMapped = await db
      .selectFrom("databaseInstance")
      .select("backendServiceId")
      .where("providerProjectId", "=", adopted.project.id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
    if (alreadyMapped !== undefined && alreadyMapped.backendServiceId !== input.backendServiceId) {
      throw new Error(`Neon project ${adopted.project.id} is already mapped to another service`)
    }

    const neon = parseNeonUri(adopted.connectionUri)
    const details = detailsFor(input)
    const secret = generateSecret()
    const roleId = v7()
    const sealed = await seal(neon.password, rolePasswordContext(roleId))
    await db.transaction().execute(async (tx) => {
      const instanceId = v7()
      const branchId = v7()
      await tx
        .insertInto("databaseInstance")
        .values({
          id: instanceId,
          backendServiceId: input.backendServiceId,
          projectId: input.projectId,
          provider: "neon",
          providerProjectId: adopted.project.id,
          region: adopted.project.region_id,
          status: "active",
        })
        .execute()
      await tx
        .insertInto("databaseBranch")
        .values({
          id: branchId,
          databaseInstanceId: instanceId,
          name: "main",
          kind: "primary",
          providerBranchId: adopted.branch.id,
          host: neon.host,
          isProtected: true,
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
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
          oauthGrantId: input.credentialOwner?.oauthGrantId ?? null,
        })
        .execute()
    })
    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()
    return {
      ...details,
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  /** Not recoverable: `service_credential` holds a one-way hash, as for every kind but object storage. */
  function connectionUri(backendServiceId: string): Promise<string> {
    return Promise.reject(new SecretNotRecoverableError(backendServiceId))
  }

  async function rotateCredentials(backendServiceId: string, owner?: CredentialOwner) {
    const service = await locate(backendServiceId)
    const details = detailsFor({ backendServiceId, organizationId: service.organizationId })
    const secret = generateSecret()

    // Only the customer-facing credential. Neon's password is untouched, because rotating it would
    // mean a Neon API call whose failure leaves the proxy unable to reach a database the customer
    // can still authenticate to.
    await db.transaction().execute(async (tx) => {
      let revoke = tx
        .updateTable("serviceCredential")
        .set({ revokedAt: new Date() })
        .where("backendServiceId", "=", backendServiceId)
        .where("revokedAt", "is", null)
      revoke =
        owner?.oauthGrantId == null
          ? revoke.where("oauthGrantId", "is", null)
          : revoke.where("oauthGrantId", "=", owner.oauthGrantId)
      await revoke.execute()

      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
          oauthGrantId: owner?.oauthGrantId ?? null,
        })
        .execute()
    })

    return {
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  /**
   * Suspension is a row.
   *
   * Not a Neon API call: Neon suspends the compute on its own when nobody connects, which is the
   * behaviour we want anyway. What this stops is `pg-proxy` opening a connection at all — and
   * because Neon only wakes on connection, refusing the connection is exactly what makes a
   * suspended service stop costing anything.
   */
  async function suspend(backendServiceId: string): Promise<void> {
    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function resume(backendServiceId: string): Promise<void> {
    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function destroy(backendServiceId: string): Promise<void> {
    const instance = await db
      .selectFrom("databaseInstance")
      .select(["providerProjectId"])
      .where("backendServiceId", "=", backendServiceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    // Deleting the project takes every branch with it, which is the point: a customer asking to
    // delete a database means all of it, not the primary branch and a scatter of previews.
    if (instance?.providerProjectId != null) {
      await deleteNeonProject(api, instance.providerProjectId)
    }

    await db
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()

    await db
      .updateTable("databaseInstance")
      .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .execute()
  }

  return {
    kind: "postgres",
    connectionUri,
    destroy,
    details: async (id) => {
      const service = await locate(id)
      return detailsFor({ backendServiceId: id, organizationId: service.organizationId })
    },
    provision,
    recoverProvision,
    resume,
    rotateCredentials,
    suspend,
  }
}

/** Delete idempotently, while preserving every provider failure that still needs a retry. */
export async function deleteNeonProject(
  api: { deleteProject(projectId: string): Promise<void> },
  providerProjectId: string,
): Promise<void> {
  try {
    await api.deleteProject(providerProjectId)
  } catch (error) {
    // A retry after a successful provider delete is complete. Authentication, throttling and
    // server failures are not: swallowing those marks a still-billable Neon project deleted in
    // the control plane and ensures no later retry can find its provider id.
    if (!(error instanceof NeonApiError && error.status === 404)) throw error
  }
}

/** The driver, wired from the environment. */
export function neonPostgresDriverFromEnv(db: Kysely<DB>): ServiceDriver {
  return neonPostgresDriver(db, neonPostgresConfigFromEnv())
}
