import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  couchDbDriver,
  couchDbServiceConfigFromEnv,
  databaseNameFor,
  SUSPENDED_ROLE,
  userNameFor,
  type CouchDbServiceConfig,
} from "./couchdb"
import { SecretNotRecoverableError } from "./valkey"

/**
 * CouchDB as a backend service, for `obsidian-livesync` and anything else that replicates.
 *
 * The interesting assertions here are not "does it call CouchDB" — they are about the two things
 * that decide whether one customer can read another's notes: the order the three provisioning calls
 * are made in, and what ends up in `_security`.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const config: CouchDbServiceConfig = {
  adminUrl: "http://admin:adminpw@couch.internal:5984",
  publicHost: "couch.selloutjobs.com",
  publicPort: 443,
  scheme: "https",
}

/** A CouchDB that records what it was asked, and answers the way the real one does. */
function fakeCouch() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const revs = new Map<string, string>()
  let authorization: string | null = null

  const doFetch = ((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + (new URL(String(url)).search || "")
    const raw = init?.body
    const body: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined
    calls.push({ method: init?.method ?? "GET", path, body })
    authorization = new Headers(init?.headers).get("Authorization")

    if (init?.method === "GET" && path.includes("/_users/")) {
      const rev = revs.get(path)
      return Promise.resolve(
        rev === undefined
          ? new Response("{}", { status: 404 })
          : new Response(JSON.stringify({ _rev: rev }), { status: 200 }),
      )
    }

    if (init?.method === "PUT" && path.includes("/_users/")) revs.set(path, "2-abc")

    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  }) as typeof fetch

  return { doFetch, calls, authorization: () => authorization }
}

const created: string[] = []

async function service() {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `couch-${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Couch Org",
      slug: `couch-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()

  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()

  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "My Vault",
      kind: "couchdb",
      status: "provisioning",
    })
    .execute()

  created.push(organizationId, userId)
  return { backendServiceId, organizationId }
}

afterAll(async () => {
  if (!reachable || created.length === 0) return
  await db.deleteFrom("organization").where("id", "in", created).execute()
  await db.deleteFrom("user").where("id", "in", created).execute()
  await db.destroy()
})

describe("couchDbServiceConfigFromEnv", () => {
  it("refuses rather than defaulting the public host to the admin URL", () => {
    /*
      The admin URL carries CouchDB's *server administrator* credentials in its userinfo. Falling
      back to it would not merely bypass a boundary — it would put the keys to every other
      customer's database into one customer's connection string.
    */
    expect(() =>
      couchDbServiceConfigFromEnv({ SERVICE_COUCHDB_ADMIN_URL: "http://a:b@c:5984" }),
    ).toThrow(/PUBLIC_HOST/)
  })

  it("defaults to https, because a phone will not replicate over plaintext", () => {
    const resolved = couchDbServiceConfigFromEnv({
      SERVICE_COUCHDB_ADMIN_URL: "http://a:b@c:5984",
      SERVICE_COUCHDB_PUBLIC_HOST: "couch.example.com",
    })

    expect(resolved.scheme).toBe("https")
  })
})

describe("naming", () => {
  it("prefixes, because a CouchDB database may not start with a digit", () => {
    // A ULID can begin with one, and CouchDB answers `illegal_database_name` — which reads like a
    // bug in the caller rather than a naming rule.
    const id = "01a02486-be04-776f-a9e2-c655b19e16b7"
    expect(databaseNameFor(id)).toMatch(/^db_[0-9a-z]{26}$/)
    expect(userNameFor(id)).toMatch(/^u_[0-9a-z]{26}$/)
  })
})

describe.runIf(reachable)("the CouchDB driver", () => {
  it("creates the user before the database, so the database is never briefly open", async () => {
    /*
      The order is the isolation.

      A database created before its owner exists is, for the moment between the two calls, a
      database with no `_security` object — and CouchDB treats that as readable by any authenticated
      user. Every other tenant is an authenticated user.
    */
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()

    await couchDbDriver(db, config, couch.doFetch).provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Vault",
    })

    const writes = couch.calls.filter((call) => call.method === "PUT").map((call) => call.path)
    const database = databaseNameFor(backendServiceId)

    expect(writes[0]).toContain("/_users/")
    expect(writes[1]).toBe(`/${database}`)
    expect(writes[2]).toBe(`/${database}/_security`)
  })

  it("makes the tenant a member and nobody an admin", async () => {
    // A database admin can rewrite `_security` — including adding anyone else. That is not a power
    // a tenant needs over their own database, and it is exactly the power that would let one open
    // theirs to another.
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()

    await couchDbDriver(db, config, couch.doFetch).provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Vault",
    })

    const security = couch.calls.find((call) => call.path.endsWith("/_security"))?.body

    expect(security).toEqual({
      admins: { names: [], roles: [] },
      members: { names: [userNameFor(backendServiceId)], roles: [] },
    })
  })

  it("hands back a URI the plugin can use, with no port on the default", async () => {
    // A URI carrying `:443` is one a customer pastes into a client that then fails to match a
    // certificate.
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()

    const result = await couchDbDriver(db, config, couch.doFetch).provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Vault",
    })

    expect(result.connectionUri).toMatch(
      new RegExp(
        `^https://${userNameFor(backendServiceId)}:[^@]+@couch\\.selloutjobs\\.com/${databaseNameFor(backendServiceId)}$`,
      ),
    )
    expect(result.connectionUri).not.toContain(":443")
  })

  it("stores a hash, and refuses to reveal the secret afterwards", async () => {
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()
    const driver = couchDbDriver(db, config, couch.doFetch)

    const result = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "My Vault",
    })

    const secret = decodeURIComponent(new URL(result.connectionUri).password)
    const stored = await db
      .selectFrom("serviceCredential")
      .select(["secretHash", "lastFour"])
      .where("backendServiceId", "=", backendServiceId)
      .executeTakeFirstOrThrow()

    expect(stored.secretHash).not.toContain(secret)
    expect(secret.endsWith(stored.lastFour)).toBe(true)
    await expect(driver.connectionUri(backendServiceId)).rejects.toBeInstanceOf(
      SecretNotRecoverableError,
    )
  })

  it("suspends by emptying the member list, leaving the data alone", async () => {
    /*
      Not by deleting the user and not by changing their password: both destroy what `resume` would
      restore. The data sits untouched and the customer's URI keeps working afterwards.
    */
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()
    const driver = couchDbDriver(db, config, couch.doFetch)

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "V" })
    couch.calls.length = 0
    await driver.suspend(backendServiceId)

    expect(couch.calls.map((call) => call.method)).toEqual(["PUT"])
    /*
      A role nobody holds — **not** an empty list.

      CouchDB treats a database whose `members.names` and `members.roles` are both empty as public
      to every authenticated user. Emptying the list did not lock the database, it opened it to
      every other tenant on the server, and the integration test found it by noticing the owner
      could still read after being suspended.
    */
    expect(couch.calls[0]?.body).toEqual({
      admins: { names: [], roles: [] },
      members: { names: [], roles: [SUSPENDED_ROLE] },
    })

    const row = await db
      .selectFrom("backendService")
      .select(["status"])
      .where("id", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    // The column the rest of the platform reads. The Postgres driver set only its own detail table,
    // and its suspensions did nothing at all.
    expect(row.status).toBe("suspended")
  })

  it("resumes the same user, so the customer's URI keeps working", async () => {
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()
    const driver = couchDbDriver(db, config, couch.doFetch)

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "V" })
    await driver.suspend(backendServiceId)
    couch.calls.length = 0
    await driver.resume?.(backendServiceId)

    expect(couch.calls[0]?.body).toEqual({
      admins: { names: [], roles: [] },
      members: { names: [userNameFor(backendServiceId)], roles: [] },
    })
  })

  it("reads the revision before rotating, because a blind PUT is a 409", async () => {
    // CouchDB requires `_rev` to update a document. Without it the answer is a conflict, which
    // reads as another writer rather than as a missing revision.
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()
    const driver = couchDbDriver(db, config, couch.doFetch)

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "V" })
    couch.calls.length = 0
    const rotated = await driver.rotateCredentials(backendServiceId)

    expect(couch.calls[0]?.method).toBe("GET")
    expect((couch.calls[1]?.body as { _rev?: string })?._rev).toBe("2-abc")

    // And the old credential is revoked, so the count of live ones stays at one.
    const live = await db
      .selectFrom("serviceCredential")
      .select(["id"])
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()

    expect(live).toHaveLength(1)
    expect(rotated).toContain(databaseNameFor(backendServiceId))
  })

  it("authenticates as the server administrator, without putting it in the URL", async () => {
    // The credentials come out of the admin URL's userinfo and go into an Authorization header. A
    // URL carrying them is one that lands in every proxy log between here and the database.
    const couch = fakeCouch()
    const { backendServiceId, organizationId } = await service()

    await couchDbDriver(db, config, couch.doFetch).provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "V",
    })

    expect(couch.authorization()).toBe(`Basic ${Buffer.from("admin:adminpw").toString("base64")}`)
    expect(couch.calls.every((call) => !call.path.includes("adminpw"))).toBe(true)
  })
})
