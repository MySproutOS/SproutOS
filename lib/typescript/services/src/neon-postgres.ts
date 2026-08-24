import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { assertSafeIdentifier, databaseNameFor, postgresUri, roleNameFor } from "./naming"
import { neonConfigFromEnv, neonStorage, type NeonConfig } from "./neon"
import {
  createEndpoint,
  dockerComputeLauncher,
  neonComputeConfigFromEnv,
  suspendEndpoint,
  type ComputeLauncher,
} from "./neon-compute"
import { generateSecret, hashGeneratedSecret, lastFour, tenantUsername } from "./tenant-auth"
import type { ConnectionDetails, ProvisionInput, ProvisionResult, ServiceDriver } from "./types"
import { SecretNotRecoverableError } from "./valkey"

/**
 * Postgres on self-hosted Neon: `database_instance.provider = 'neon'`.
 *
 * The sibling of `sproutPostgresDriver`, and the difference is what a database *is*. `sprout`
 * creates a role and a database on a cluster that is always running, so provisioning costs a
 * connection and the database costs money from that moment whether or not anyone uses it. This
 * creates a tenant and a timeline in the pageserver and **starts nothing** — the customer receives a
 * working connection string for a database with no process behind it, and the first connection
 * through `pg-proxy` wakes one in about 200ms.
 *
 * ## What that unlocks, and why it was descoped before
 *
 * The OAuth provider's per-user database provisioning was descoped from v1 with the reason recorded
 * as "at 100k+ databases it needs capabilities the control plane won't have until phase 8 matures".
 * This is that capability: 100,000 suspended endpoints are 100,000 rows and 100,000 timelines, and
 * they cost storage and no compute. On `sprout` the same thing is 100,000 idle Postgres databases on
 * a cluster somebody is paying for.
 *
 * ## The customer's credential is still the proxy's
 *
 * Unchanged from `sprout`, deliberately. The username is `tenantUsername` and the secret is stored
 * as a one-way hash, `pg-proxy` is the only thing that verifies it, and the role inside the compute
 * has no password at all. A customer never holds anything that works against a compute directly —
 * which matters more here than on the shared cluster, because a compute is reachable on a network
 * the platform, not the customer, controls.
 */

export type NeonPostgresConfig = {
  neon: NeonConfig
  /** What goes in a customer's URI: `pg-proxy`, never a compute. */
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
        "thing a customer is given — a URI naming a compute would name a process that is usually " +
        "not running.",
    )
  }

  return {
    neon: neonConfigFromEnv(env),
    publicHost,
    publicPort: Number(env.SERVICE_POSTGRES_PUBLIC_PORT ?? 5432),
    ...(env.SERVICE_POSTGRES_SSLMODE === undefined
      ? {}
      : { sslmode: env.SERVICE_POSTGRES_SSLMODE }),
  }
}

export function neonPostgresDriver(
  db: Kysely<DB>,
  config: NeonPostgresConfig,
  launcher: ComputeLauncher,
): ServiceDriver {
  const storage = neonStorage(config.neon)

  function detailsFor(input: {
    backendServiceId: string
    organizationId: string
  }): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      database: databaseNameFor(input.backendServiceId),
      username: tenantUsername({
        organizationId: input.organizationId,
        kind: "database",
        resourceId: input.backendServiceId,
      }),
    }
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const database = databaseNameFor(input.backendServiceId)
    const role = roleNameFor(input.backendServiceId)
    // Both are derived from a UUID and cannot contain anything that needs escaping. Checked anyway,
    // because they reach `compute_ctl`'s spec and from there `create role` and `create database`.
    assertSafeIdentifier(database)
    assertSafeIdentifier(role)

    const details = detailsFor(input)

    // Storage first. If anything below fails the tenant is orphaned, which `destroy` and the reaper
    // both handle — whereas a `database_instance` row pointing at a tenant that was never created is
    // a database the customer can see and nothing can serve.
    const tenantId = await storage.createTenant()
    const timeline = await storage.createTimeline(tenantId)

    const secret = generateSecret()

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
          providerProjectId: tenantId,
          region: null,
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
          providerBranchId: timeline.timeline_id,
          host: config.publicHost,
          isProtected: true,
        })
        .execute()

      await createEndpoint(tx, {
        backendServiceId: input.backendServiceId,
        databaseBranchId: branchId,
        tenantId,
        timelineId: timeline.timeline_id,
        roleName: role,
        databaseName: database,
      })

      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId: input.backendServiceId,
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
        })
        .execute()
    })

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()

    /*
      Nothing is started.

      The customer has a working connection string for a database with no process behind it. That is
      not a half-provisioned state to be finished later — it is the finished state, and the first
      connection wakes a compute in about 200ms.
    */
    return {
      ...details,
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  /** Not recoverable: `service_credential` holds a one-way hash, as it does for every kind but object storage. */
  function connectionUri(backendServiceId: string): Promise<string> {
    return Promise.reject(new SecretNotRecoverableError(backendServiceId))
  }

  async function rotateCredentials(backendServiceId: string): Promise<string> {
    const service = await db
      .selectFrom("backendService")
      .select(["organizationId"])
      .where("id", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    const details = detailsFor({ backendServiceId, organizationId: service.organizationId })
    const secret = generateSecret()

    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable("serviceCredential")
        .set({ revokedAt: new Date() })
        .where("backendServiceId", "=", backendServiceId)
        .where("revokedAt", "is", null)
        .execute()

      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
        })
        .execute()
    })

    return postgresUri({
      ...details,
      password: secret,
      ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
    })
  }

  async function endpointsFor(backendServiceId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("neonEndpoint")
      .select("id")
      .where("backendServiceId", "=", backendServiceId)
      .execute()

    return rows.map((row) => row.id)
  }

  /**
   * Stop the computes and refuse new connections.
   *
   * Two things, because they answer different questions. Stopping the compute is what makes a
   * suspended service stop costing anything; `backend_service.status` is what stops `pg-proxy`
   * waking it again on the next connection. Doing only the first would suspend a service that
   * un-suspends itself the moment anyone connects.
   */
  async function suspend(backendServiceId: string): Promise<void> {
    for (const endpointId of await endpointsFor(backendServiceId)) {
      await suspendEndpoint(db, launcher, endpointId)
    }

    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function resume(backendServiceId: string): Promise<void> {
    // Only the status. Starting a compute here would defeat the point — the next connection does
    // it, and a resumed database nobody connects to should cost nothing.
    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function destroy(backendServiceId: string): Promise<void> {
    const endpoints = await db
      .selectFrom("neonEndpoint")
      .select(["id", "tenantId"])
      .where("backendServiceId", "=", backendServiceId)
      .execute()

    for (const endpoint of endpoints) {
      await suspendEndpoint(db, launcher, endpoint.id).catch(() => undefined)
    }

    // The tenant, which is every branch of this database at once. Deleted after the computes, so
    // nothing is still writing WAL for a tenant that is going away.
    for (const tenantId of new Set(endpoints.map((endpoint) => endpoint.tenantId))) {
      await storage.deleteTenant(tenantId).catch(() => undefined)
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
      const service = await db
        .selectFrom("backendService")
        .select(["organizationId"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow()

      return detailsFor({ backendServiceId: id, organizationId: service.organizationId })
    },
    provision,
    resume,
    rotateCredentials,
    suspend,
  }
}

/** The driver, wired from the environment. */
export function neonPostgresDriverFromEnv(db: Kysely<DB>): ServiceDriver {
  return neonPostgresDriver(
    db,
    neonPostgresConfigFromEnv(),
    dockerComputeLauncher(neonComputeConfigFromEnv()),
  )
}
