import { db } from "@sproutos/db"
import { sql } from "kysely"
import { Client } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { databaseNameFor, roleNameFor } from "./naming"
import { sproutPostgresConfigFromEnv, sproutPostgresDriver } from "./postgres"
import { ServiceNotProvisionedError } from "./types"

/**
 * Provisions real databases on the compose Postgres and connects to them with the URI it hands
 * back. That round trip is the only thing that proves this works: a mocked `pg` would confirm the
 * SQL I wrote, not that Postgres accepts it or that the credential it produces can log in.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    // KMS too — the password is sealed on the way in and opened on the way out.
    if ((process.env.KMS_KEY_ID ?? "") === "") return false
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
})()

const provisioned: string[] = []
const fixtures = { users: [] as string[], organizations: [] as string[] }

afterAll(async () => {
  if (!reachable) return
  const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
  for (const id of provisioned) {
    await driver.destroy(id).catch(() => undefined)
  }
  // Guarded rather than padded: an empty IN list is a syntax error, and the obvious workaround —
  // concatenating a sentinel — sends a non-UUID to a uuid column and fails differently.
  if (provisioned.length > 0) {
    await db.deleteFrom("backendService").where("id", "in", provisioned).execute()
  }
  if (fixtures.organizations.length > 0) {
    await db.deleteFrom("organization").where("id", "in", fixtures.organizations).execute()
  }
  if (fixtures.users.length > 0) {
    await db.deleteFrom("user").where("id", "in", fixtures.users).execute()
  }
  await db.destroy()
})

async function service(): Promise<string> {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `svc-${userId}@test.invalid`, name: "Svc" })
    .execute()
  fixtures.users.push(userId)

  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Service Org",
      slug: `svc-${organizationId}`,
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
      name: "My Database",
      kind: "postgres",
      status: "provisioning",
    })
    .execute()

  provisioned.push(backendServiceId)
  return backendServiceId
}

describe.skipIf(!reachable)("sprout postgres driver", () => {
  it("hands back a URI that actually connects", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const id = await service()

    const result = await driver.provision({
      backendServiceId: id,
      organizationId: "unused",
      projectId: null,
      name: "My Database",
    })

    expect(result.database).toBe(databaseNameFor(id))
    expect(result.username).toBe(roleNameFor(id))

    // The whole point. Anything less than logging in with it is checking my own string building.
    const client = new Client({ connectionString: result.connectionUri })
    await client.connect()
    try {
      const { rows } = await client.query<{ db: string; who: string }>(
        "select current_database() as db, current_user as who",
      )
      expect(rows[0]?.db).toBe(databaseNameFor(id))
      expect(rows[0]?.who).toBe(roleNameFor(id))
    } finally {
      await client.end()
    }
  }, 60_000)

  it("round-trips the password through KMS", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const id = await service()

    const provisioned = await driver.provision({
      backendServiceId: id,
      organizationId: "unused",
      projectId: null,
      name: "Reveal Me",
    })

    // Read back later, from the sealed column, and still usable.
    const revealed = await driver.connectionUri(id)
    expect(revealed).toBe(provisioned.connectionUri)

    const client = new Client({ connectionString: revealed })
    await client.connect()
    await client.end()
  }, 60_000)

  it("stores no plaintext password anywhere", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const id = await service()
    const result = await driver.provision({
      backendServiceId: id,
      organizationId: "unused",
      projectId: null,
      name: "Secret",
    })

    const password = decodeURIComponent(new URL(result.connectionUri).password)
    expect(password.length).toBeGreaterThan(20)

    const roles = await db
      .selectFrom("databaseRole")
      .innerJoin("databaseBranch", "databaseBranch.id", "databaseRole.databaseBranchId")
      .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
      .selectAll("databaseRole")
      .where("databaseInstance.backendServiceId", "=", id)
      .execute()

    // Every column on the row, not the ones I remembered to check.
    expect(JSON.stringify(roles)).not.toContain(password)
  }, 60_000)

  it("rotation invalidates the old URI", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const id = await service()
    const original = await driver.provision({
      backendServiceId: id,
      organizationId: "unused",
      projectId: null,
      name: "Rotate",
    })

    const rotated = await driver.rotateCredentials(id)
    expect(rotated).not.toBe(original.connectionUri)

    // The only recovery from a leaked URI is one that stops working.
    const stale = new Client({ connectionString: original.connectionUri })
    await expect(stale.connect()).rejects.toThrow(/password authentication failed/)

    const fresh = new Client({ connectionString: rotated })
    await fresh.connect()
    await fresh.end()
  }, 60_000)

  it("suspending stops logins without destroying data", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const id = await service()
    const result = await driver.provision({
      backendServiceId: id,
      organizationId: "unused",
      projectId: null,
      name: "Suspend",
    })

    const before = new Client({ connectionString: result.connectionUri })
    await before.connect()
    await before.query("create table kept (id int)")
    await before.end()

    await driver.suspend(id)

    const after = new Client({ connectionString: result.connectionUri })
    await expect(after.connect()).rejects.toThrow(
      /is not permitted to log in|password authentication failed/,
    )

    // The database is still there — a suspension that lost data would not be a suspension.
    const admin = new Client({ connectionString: sproutPostgresConfigFromEnv().adminUrl })
    await admin.connect()
    try {
      const { rows } = await admin.query<{ n: string }>(
        "select count(*) as n from pg_database where datname = $1",
        [databaseNameFor(id)],
      )
      expect(rows[0]?.n).toBe("1")
    } finally {
      await admin.end()
    }
  }, 60_000)

  it("refuses to answer for a service that was never provisioned", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    await expect(driver.connectionUri(v7())).rejects.toBeInstanceOf(ServiceNotProvisionedError)
  })
})
