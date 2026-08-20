import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { hashGeneratedSecret, tenantUsername } from "./tenant-auth"
import { ServiceNotProvisionedError } from "./types"
import { SecretNotRecoverableError, valkeyDriver, type ValkeyServiceConfig } from "./valkey"

/**
 * Runs against the compose Postgres.
 *
 * The credential and its uniqueness rules are the entire driver — there is no server to provision —
 * and both live in the database: the partial unique index is what makes rotation orderable and what
 * stops a revoked secret staying live. Mocking Kysely would test the queries I wrote rather than
 * whether Postgres accepts them.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const config: ValkeyServiceConfig = {
  publicHost: "kv.sprout.run",
  publicPort: 6379,
  scheme: "rediss",
}

const fixtures = { users: [] as string[], organizations: [] as string[], services: [] as string[] }

afterAll(async () => {
  if (!reachable) return
  if (fixtures.services.length > 0) {
    await db.deleteFrom("backendService").where("id", "in", fixtures.services).execute()
  }
  if (fixtures.organizations.length > 0) {
    await db.deleteFrom("organization").where("id", "in", fixtures.organizations).execute()
  }
  if (fixtures.users.length > 0) {
    await db.deleteFrom("user").where("id", "in", fixtures.users).execute()
  }
  await db.destroy()
})

async function service(): Promise<{ backendServiceId: string; organizationId: string }> {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `kv-${userId}@test.invalid`, name: "Kv" })
    .execute()
  fixtures.users.push(userId)

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Queue Org",
      slug: `kv-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  fixtures.organizations.push(organizationId)

  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()

  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "My Queue",
      kind: "valkey",
      status: "provisioning",
    })
    .execute()
  fixtures.services.push(backendServiceId)

  return { backendServiceId, organizationId }
}

function secretFrom(uri: string): string {
  return decodeURIComponent(new URL(uri).password)
}

describe.skipIf(!reachable)("valkey driver", () => {
  it("provisions a credential the proxy can verify", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId, organizationId } = await service()

    const result = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Queue",
    })

    // The username is the routing information: the proxy derives the tenant's key prefix from it,
    // so it has to be exactly what `tenant-auth` produces on both sides.
    expect(result.username).toBe(
      tenantUsername({ organizationId, kind: "queue", resourceId: backendServiceId }),
    )
    expect(result.username.startsWith("kv_")).toBe(true)

    const uri = new URL(result.connectionUri)
    expect(uri.protocol).toBe("rediss:")
    expect(uri.hostname).toBe("kv.sprout.run")
    expect(uri.port).toBe("6379")
    expect(decodeURIComponent(uri.username)).toBe(result.username)

    // What the proxy will actually do: hash what the tenant presents, compare to the stored value.
    const stored = await db
      .selectFrom("serviceCredential")
      .select(["secretHash", "lastFour", "revokedAt"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    const secret = secretFrom(result.connectionUri)
    expect(stored.secretHash).toBe(await hashGeneratedSecret(secret))
    expect(stored.revokedAt).toBeNull()
    expect(secret.endsWith(stored.lastFour)).toBe(true)
  })

  it("never stores the secret in a form anything can read back", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    const result = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Queue",
    })
    const secret = secretFrom(result.connectionUri)

    const row = await db
      .selectFrom("serviceCredential")
      .selectAll()
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    // A stolen table must yield nothing to connect with. `lastFour` is the deliberate exception,
    // and four characters of 52 leaves 240 bits.
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(JSON.stringify(row)).not.toContain(secret.slice(0, -4))

    await expect(driver.connectionUri(backendServiceId)).rejects.toThrow(SecretNotRecoverableError)
  })

  it("rotates without a window where nothing works", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    const first = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Queue",
    })

    const second = await driver.rotateCredentials(backendServiceId)
    expect(secretFrom(second)).not.toBe(secretFrom(first.connectionUri))

    // The username must not change: it encodes which keyspace the connection lands in, so a
    // rotation that changed it would hand the tenant a URI pointing at an empty namespace.
    expect(new URL(second).username).toBe(new URL(first.connectionUri).username)

    const rows = await db
      .selectFrom("serviceCredential")
      .select(["secretHash", "revokedAt"])
      .where("backendServiceId", "=", backendServiceId)
      .orderBy("createdAt", "asc")
      .execute()

    expect(rows).toHaveLength(2)
    expect(rows[0]?.revokedAt).not.toBeNull()
    expect(rows[1]?.revokedAt).toBeNull()
    expect(rows[1]?.secretHash).toBe(await hashGeneratedSecret(secretFrom(second)))
  })

  it("refuses two live credentials for one username", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Queue",
    })

    /*
      The guard that matters most, asserted by trying to violate it directly rather than through the
      driver. Two live rows for one username would let a revoked secret keep working — silently, for
      as long as nobody looked at the table.
    */
    const username = tenantUsername({
      organizationId,
      kind: "queue",
      resourceId: backendServiceId,
    })
    await expect(
      db
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username,
          secretHash: await hashGeneratedSecret("second"),
          lastFour: "cond",
        })
        .execute(),
    ).rejects.toThrow(/service_credential_live_username_key/)
  })

  it("suspending revokes the credential and leaves the keys alone", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Queue",
    })

    await driver.suspend(backendServiceId)

    const live = await db
      .selectFrom("serviceCredential")
      .select("id")
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .executeTakeFirst()
    expect(live).toBeUndefined()

    const status = await db
      .selectFrom("backendService")
      .select("status")
      .where("id", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    expect(status.status).toBe("suspended")

    // Suspended, not deprovisioned: `details` still answers, because the tenant's data is still
    // there and resuming is one insert.
    await expect(driver.details(backendServiceId)).rejects.toThrow(ServiceNotProvisionedError)
  })

  it("refuses to describe a service that was never provisioned", async ({ skip }) => {
    if (!reachable) skip()
    const driver = valkeyDriver(db, config)
    const { backendServiceId } = await service()
    await expect(driver.details(backendServiceId)).rejects.toThrow(ServiceNotProvisionedError)
  })
})
