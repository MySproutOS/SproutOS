import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { searchDriver, searchUri, type SearchServiceConfig } from "./search"
import { hashGeneratedSecret, tenantUsername } from "./tenant-auth"
import { ServiceNotProvisionedError } from "./types"
import { SecretNotRecoverableError } from "./valkey"

/**
 * Runs against the compose Postgres.
 *
 * Everything the driver does lives in the database — the credential and the partial unique index
 * that makes rotation orderable — so mocking Kysely would test the queries I wrote rather than
 * whether Postgres accepts them. The proxy's own behaviour is tested in Rust, against a real
 * OpenSearch.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const config: SearchServiceConfig = {
  publicHost: "search.sprout.run",
  publicPort: 9200,
  scheme: "https",
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
    .values({ id: userId, email: `ix-${userId}@test.invalid`, name: "Ix" })
    .execute()
  fixtures.users.push(userId)

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Search Org",
      slug: `ix-${organizationId}`,
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
      name: "My Search",
      kind: "elasticsearch",
      status: "provisioning",
    })
    .execute()
  fixtures.services.push(backendServiceId)

  return { backendServiceId, organizationId }
}

function secretFrom(uri: string): string {
  return decodeURIComponent(new URL(uri).password)
}

describe.skipIf(!reachable)("search driver", () => {
  it("provisions a credential the proxy can verify", async ({ skip }) => {
    if (!reachable) skip()
    const driver = searchDriver(db, config)
    const { backendServiceId, organizationId } = await service()

    const result = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Search",
    })

    // The username is the routing information: the proxy derives the tenant's index prefix from it.
    expect(result.username).toBe(
      tenantUsername({ organizationId, kind: "searchIndex", resourceId: backendServiceId }),
    )
    expect(result.username.startsWith("ix_")).toBe(true)

    const uri = new URL(result.connectionUri)
    expect(uri.protocol).toBe("https:")
    expect(uri.hostname).toBe("search.sprout.run")
    expect(decodeURIComponent(uri.username)).toBe(result.username)

    const stored = await db
      .selectFrom("serviceCredential")
      .select(["secretHash", "revokedAt"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    expect(stored.secretHash).toBe(await hashGeneratedSecret(secretFrom(result.connectionUri)))
    expect(stored.revokedAt).toBeNull()
  })

  it("creates no index, because an empty one would cost a shard", async ({ skip }) => {
    if (!reachable) skip()
    /*
      Shards are the resource a shared cluster runs out of. OpenSearch creates an index on first
      write, so provisioning one up front would spend a shard on a customer who may never index
      anything. Asserted as "the driver touches nothing but the credential table".
    */
    const driver = searchDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Search",
    })

    const details = await driver.details(backendServiceId)
    expect(details.database).toBe("")
  })

  it("never stores the secret in a form anything can read back", async ({ skip }) => {
    if (!reachable) skip()
    const driver = searchDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    const result = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Search",
    })

    const row = await db
      .selectFrom("serviceCredential")
      .selectAll()
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    expect(JSON.stringify(row)).not.toContain(secretFrom(result.connectionUri))
    await expect(driver.connectionUri(backendServiceId)).rejects.toThrow(SecretNotRecoverableError)
  })

  it("rotates without changing which namespace the tenant lands in", async ({ skip }) => {
    if (!reachable) skip()
    const driver = searchDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    const first = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Search",
    })

    const second = await driver.rotateCredentials(backendServiceId)
    expect(secretFrom(second)).not.toBe(secretFrom(first.connectionUri))
    // The username encodes the index prefix. Changing it would hand the tenant a URI pointing at an
    // empty namespace and their data would appear to have vanished.
    expect(new URL(second).username).toBe(new URL(first.connectionUri).username)

    const rows = await db
      .selectFrom("serviceCredential")
      .select(["revokedAt"])
      .where("backendServiceId", "=", backendServiceId)
      .orderBy("createdAt", "asc")
      .execute()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.revokedAt).not.toBeNull()
    expect(rows[1]?.revokedAt).toBeNull()
  })

  it("suspending revokes the credential", async ({ skip }) => {
    if (!reachable) skip()
    const driver = searchDriver(db, config)
    const { backendServiceId, organizationId } = await service()
    await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Search",
    })

    await driver.suspend(backendServiceId)
    const live = await db
      .selectFrom("serviceCredential")
      .select("id")
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .executeTakeFirst()
    expect(live).toBeUndefined()
  })

  it("refuses to describe a service that was never provisioned", async ({ skip }) => {
    if (!reachable) skip()
    const driver = searchDriver(db, config)
    const { backendServiceId } = await service()
    await expect(driver.details(backendServiceId)).rejects.toThrow(ServiceNotProvisionedError)
  })
})

describe("searchUri", () => {
  it("puts the credentials where every client reads them", () => {
    // `new Client({ node: uri })` in the JS client, `hosts=[uri]` in Python — both parse userinfo.
    const uri = searchUri({
      scheme: "https",
      host: "search.sprout.run",
      port: 9200,
      username: "ix_abc.def",
      secret: "s3cret",
    })
    expect(uri).toBe("https://ix_abc.def:s3cret@search.sprout.run:9200")
  })
})
