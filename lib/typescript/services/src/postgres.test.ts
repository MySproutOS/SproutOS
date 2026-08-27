import { db } from "@sproutos/db"
import { sql } from "kysely"
import { Client } from "pg"
import { tenantUsername } from "./tenant-auth"
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

async function service(): Promise<{ backendServiceId: string; organizationId: string }> {
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
  /*
    The organization id as well as the service id.

    Every call site passed `organizationId: "unused"`, which was true when the driver ignored it and
    stopped being true the moment anything did — the envelope's encryption context binds a
    ciphertext to the organization it belongs to, so a placeholder there is a `RangeError` at best
    and a credential sealed under the wrong tenant at worst. The helper already creates a real
    organization; there was never a reason to invent a second, fake one.
  */
  return { backendServiceId, organizationId }
}

describe.skipIf(!reachable)("sprout postgres driver", () => {
  it("hands back a URI that actually connects", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const { backendServiceId: id, organizationId } = await service()

    const result = await driver.provision({
      backendServiceId: id,
      organizationId,
      projectId: null,
      name: "My Database",
    })

    expect(result.database).toBe(databaseNameFor(id))
    /*
      The **tenant** username, not the backend role name.

      This asserted `roleNameFor(id)` — the Postgres role — which is what the driver used to hand
      out, and the whole reason the proxy was never actually joined to the Postgres path: a URI
      carrying the backend role and its password works only by connecting to the cluster directly.
      `pg-proxy` parses the username to learn which tenant and which resource a connection is for,
      because a startup packet has room for nothing else, and then drops to the backend role with
      `SET ROLE`.

      So the test now asserts the contract the proxy actually implements, and proves it by logging
      in *through the proxy* and asking who the session ended up as.
    */
    expect(result.username).toBe(
      tenantUsername({ organizationId, kind: "database", resourceId: id }),
    )
    expect(result.username).not.toBe(roleNameFor(id))

    // The whole point. Anything less than logging in with it is checking my own string building.
    const client = new Client({ connectionString: result.connectionUri })
    await client.connect()
    try {
      const { rows } = await client.query<{ db: string; who: string }>(
        "select current_database() as db, current_user as who",
      )
      expect(rows[0]?.db).toBe(databaseNameFor(id))
      // `SET ROLE` has happened by the time the session is spliced: the proxy's own privilege is
      // dropped before the customer sees the connection.
      expect(rows[0]?.who).toBe(roleNameFor(id))
    } finally {
      await client.end()
    }
  }, 60_000)

  it("round-trips the password through KMS", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const { backendServiceId: id, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId: id,
      organizationId,
      projectId: null,
      name: "Reveal Me",
    })

    /*
      The secret is not recoverable, and that is the design.

      This asserted that `connectionUri` returned the same URI a second time. `service_credential`
      stores a one-way hash — the change that made a leak of the control-plane database yield
      nothing a customer's database would accept — so there is nothing left to reveal. The driver
      says so in the error rather than returning a URI with an empty password, which is what a
      caller would otherwise take away and spend an afternoon on.

      What is still true, and worth asserting, is that the URI handed out at provision time works.
    */
    await expect(driver.connectionUri(id)).rejects.toThrow(/one-way hash|Rotate/)

    const client = new Client({ connectionString: provisioned.connectionUri })
    await client.connect()
    await client.end()
  }, 60_000)

  it("stores no plaintext password anywhere", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const { backendServiceId: id, organizationId } = await service()
    const result = await driver.provision({
      backendServiceId: id,
      organizationId,
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
    const { backendServiceId: id, organizationId } = await service()
    const original = await driver.provision({
      backendServiceId: id,
      organizationId,
      projectId: null,
      name: "Rotate",
    })

    const rotated = await driver.rotateCredentials(id)
    expect(rotated.connectionUri).not.toBe(original.connectionUri)
    expect(rotated).toEqual({ connectionUri: rotated.connectionUri })

    // The only recovery from a leaked URI is one that stops working.
    const stale = new Client({ connectionString: original.connectionUri })
    await expect(stale.connect()).rejects.toThrow(/password authentication failed/)

    const fresh = new Client({ connectionString: rotated.connectionUri })
    await fresh.connect()
    await fresh.end()
  }, 60_000)

  it("suspending stops logins without destroying data", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const { backendServiceId: id, organizationId } = await service()
    const result = await driver.provision({
      backendServiceId: id,
      organizationId,
      projectId: null,
      name: "Suspend",
    })

    const before = new Client({ connectionString: result.connectionUri })
    await before.connect()
    await before.query("create table kept (id int)")
    await before.end()

    await driver.suspend(id)

    /*
      Refused **through the proxy**, which is the only path a customer has.

      This passed for a long time by accident: it connected directly to the backend, where `alter
      role … nologin` is the whole suspension. Through `pg-proxy` it is not — the proxy
      authenticates as itself and reaches the tenant's role with `SET ROLE`, and `SET ROLE` to a
      `NOLOGIN` role succeeds, because `NOLOGIN` governs authentication and not role assumption.

      What refuses is the credential lookup, which requires `backend_service.status` to be
      `provisioning` or `active`. The Valkey and search drivers set that column; this one set
      `database_instance.status` instead, so a suspended Postgres service — including one suspended
      for non-payment — went on accepting connections.
    */
    const after = new Client({ connectionString: result.connectionUri })
    await expect(after.connect()).rejects.toThrow(
      /is not permitted to log in|password authentication failed|authentication failed/,
    )

    const suspended = await db
      .selectFrom("backendService")
      .select(["status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(suspended.status).toBe("suspended")

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

  it("resuming lets the same URI back in", async ({ skip }) => {
    if (!reachable) skip()
    /*
      `suspend` had no counterpart anywhere — not in the driver, not in the interface, not in the
      API. A service could be stopped and never started, which makes suspension for non-payment
      useless: paying has to undo it.

      The *same* URI, not a new one, is the assertion that matters. Postgres suspends by taking
      `login` off the role, so resuming is that statement backwards and the customer's connection
      string keeps working. The other two drivers revoke the credential and cannot do this — see the
      note on `ServiceDriver.resume`.
    */
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    const { backendServiceId: id, organizationId } = await service()
    const result = await driver.provision({
      backendServiceId: id,
      organizationId,
      projectId: null,
      name: "Resume",
    })

    await driver.suspend(id)
    await driver.resume?.(id)

    const client = new Client({ connectionString: result.connectionUri })
    await client.connect()
    try {
      const { rows } = await client.query<{ db: string }>("select current_database() as db")
      expect(rows[0]?.db).toBe(databaseNameFor(id))
    } finally {
      await client.end()
    }
  }, 60_000)

  it("refuses to answer for a service that was never provisioned", async ({ skip }) => {
    if (!reachable) skip()
    const driver = sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
    await expect(driver.connectionUri(v7())).rejects.toBeInstanceOf(ServiceNotProvisionedError)
  })
})

/*
  The default that would hand a customer a route around the security boundary.

  `pg-proxy` is what identifies a tenant from their credentials, routes into their database, and
  drops its own privilege before splicing the session. A connection URI naming the backend skips all
  of it. The config used to fall back to the admin URL's hostname when `SERVICE_POSTGRES_PUBLIC_HOST`
  was unset, so a forgotten variable produced a *working* connection string straight to the cluster
  every tenant's data is on — observed on the first real provisioning.
*/
describe("sproutPostgresConfigFromEnv", () => {
  const adminUrl = "postgresql://postgres:secret@backend.internal:5432/main"

  it("refuses rather than defaulting the public host to the backend", () => {
    expect(() => sproutPostgresConfigFromEnv({ SERVICE_POSTGRES_ADMIN_URL: adminUrl })).toThrow(
      /SERVICE_POSTGRES_PUBLIC_HOST/,
    )
  })

  it("refuses an empty value too, which is what an unset ConfigMap key produces", () => {
    expect(() =>
      sproutPostgresConfigFromEnv({
        SERVICE_POSTGRES_ADMIN_URL: adminUrl,
        SERVICE_POSTGRES_PUBLIC_HOST: "",
      }),
    ).toThrow(/SERVICE_POSTGRES_PUBLIC_HOST/)
  })

  it("uses the proxy for the customer's host and the backend for its own connection", () => {
    const config = sproutPostgresConfigFromEnv({
      SERVICE_POSTGRES_ADMIN_URL: adminUrl,
      SERVICE_POSTGRES_PUBLIC_HOST: "pg-proxy.sproutos-system.svc.cluster.local",
    })
    expect(config.publicHost).toBe("pg-proxy.sproutos-system.svc.cluster.local")
    // The admin URL is the proxy's own route to the cluster and is never handed out.
    expect(config.adminUrl).toBe(adminUrl)
  })
})
