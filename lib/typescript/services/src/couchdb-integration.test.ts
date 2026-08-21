import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { couchDbDriver, couchDbServiceConfigFromEnv, databaseNameFor } from "./couchdb"

/**
 * The CouchDB driver against a real CouchDB.
 *
 * `couchdb.test.ts` asserts what the driver *asks* for; this asserts what the server does with it.
 * The two that matter cannot be checked against a fake at all:
 *
 * - **Cross-tenant reads are refused.** CouchDB is the only kind here with no proxy in front of it,
 *   on the argument that its own `_security` object is the boundary. That argument is worth exactly
 *   as much as a second tenant's credential failing against the first tenant's database, so that is
 *   what is asserted.
 * - **Obsidian's CORS preflight is answered.** `app://obsidian.md` is not a web origin, and a
 *   CouchDB that does not name it fails inside the plugin's own fetch with nothing in the server
 *   log. That failure is indistinguishable from "wrong password" to the person holding the vault.
 *
 * Runs against `docker compose up couchdb`, and skips without one.
 */
const config = (() => {
  try {
    return couchDbServiceConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config === undefined) return false
  try {
    await sql`select 1`.execute(db)
    /*
      Authenticated, because `_up` stops being public the moment the server is configured properly.

      Upstream's init script waits on `_up` unauthenticated and is right to — it runs *before*
      `require_valid_user` is applied. Afterwards the same endpoint answers 401, so an unauthenticated
      probe reports a correctly configured server as unreachable and skips the whole suite. Which is
      exactly what it did.
    */
    const url = new URL(config.adminUrl)
    const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    const response = await fetch(`${url.origin}/_up`, {
      headers: { Authorization: `Basic ${Buffer.from(pair, "utf8").toString("base64")}` },
    })
    return response.ok
  } catch {
    return false
  }
})()

const fixtures: { organizations: string[]; users: string[]; services: string[] } = {
  organizations: [],
  users: [],
  services: [],
}

async function service(name: string) {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `couch-${userId}@test.invalid` })
    .execute()
  fixtures.users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Couch",
      slug: `couch-${organizationId}`,
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
      name,
      kind: "couchdb",
      status: "provisioning",
    })
    .execute()
  fixtures.services.push(backendServiceId)

  return { backendServiceId, organizationId }
}

function basicAuth(uri: string): string {
  const url = new URL(uri)
  const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`
}

/**
 * Request a path on a connection URI, moving the credentials into a header.
 *
 * WHATWG `fetch` refuses a URL containing userinfo outright — "Request cannot be constructed from a
 * URL that includes credentials" — and the URI this driver hands back contains it, because that is
 * the form CouchDB clients take and what `obsidian-livesync` is given.
 *
 * That is not a defect in the URI. PouchDB, which is what the plugin replicates with, parses the
 * userinfo and sends it as a header itself; `fetch` is the odd one out. This helper does what the
 * client does, so the test exercises the same credential the customer was handed rather than a
 * different one constructed for the test's convenience.
 */
async function asTenant(uri: string, path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(uri)
  const authorization = basicAuth(uri)
  url.username = ""
  url.password = ""

  const headers = new Headers(init.headers)
  headers.set("Authorization", authorization)

  return await fetch(`${url.origin}${url.pathname}${path}`, { ...init, headers })
}

afterAll(async () => {
  if (!reachable || config === undefined) return

  const driver = couchDbDriver(db, config)
  for (const id of fixtures.services) {
    await driver.destroy(id).catch(() => undefined)
  }
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

describe.runIf(reachable)("a provisioned CouchDB", () => {
  it("hands back a URI a client can actually replicate against", async () => {
    const driver = couchDbDriver(db, config!)
    const { backendServiceId, organizationId } = await service("Vault")

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })

    // A PUT and a GET is what replication is made of. Anything less is checking string building.
    const written = await asTenant(provisioned.connectionUri, "/note-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hello from Obsidian" }),
    })
    expect(written.status).toBe(201)

    const read = await asTenant(provisioned.connectionUri, "/note-1")
    expect(read.status).toBe(200)
    expect(((await read.json()) as { title: string }).title).toBe("Hello from Obsidian")
  }, 60_000)

  it("refuses one tenant's credential against another tenant's database", async () => {
    /*
      The whole argument for having no proxy.

      `pg-proxy`, `valkey-proxy` and `search-proxy` exist because their servers cannot enforce this
      alone. The claim for CouchDB is that `_security` plus `require_valid_user` does — and that
      claim is worth exactly as much as this request failing.
    */
    const driver = couchDbDriver(db, config!)

    const mine = await service("Mine")
    const theirs = await service("Theirs")

    const provisioned = await driver.provision({ ...mine, projectId: null, name: "Mine" })
    const intruder = await driver.provision({ ...theirs, projectId: null, name: "Theirs" })

    await asTenant(provisioned.connectionUri, "/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "not yours" }),
    })

    const url = new URL(provisioned.connectionUri)
    const crossTenant = await fetch(
      `${url.protocol}//${url.host}/${databaseNameFor(mine.backendServiceId)}/secret`,
      { headers: { Authorization: basicAuth(intruder.connectionUri) } },
    )

    // 403, not 404: CouchDB knows the database exists and says the caller is not a member.
    expect(crossTenant.status).toBe(403)
  }, 60_000)

  it("answers a CORS preflight from Obsidian's own origin", async () => {
    /*
      `app://obsidian.md` is not a web origin, and CouchDB answers no origin it has not been told
      about. The failure is inside the plugin's fetch, with nothing in the server log — a customer
      sees "cannot connect" and cannot tell it from a wrong password.
    */
    const url = new URL(config!.adminUrl)
    const preflight = await fetch(`${url.origin}/_all_dbs`, {
      method: "OPTIONS",
      headers: {
        Origin: "app://obsidian.md",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    })

    expect(preflight.headers.get("access-control-allow-origin")).toBe("app://obsidian.md")
    // Without this the plugin cannot send its Authorization header, and every request is anonymous.
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true")
  }, 30_000)

  it("stops the tenant's own credential when suspended, and restores it", async () => {
    const driver = couchDbDriver(db, config!)
    const { backendServiceId, organizationId } = await service("Suspendable")

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Suspendable",
    })
    await asTenant(provisioned.connectionUri, "/kept", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: true }),
    })

    await driver.suspend(backendServiceId)
    expect((await asTenant(provisioned.connectionUri, "/kept")).status).toBe(403)

    await driver.resume?.(backendServiceId)
    const restored = await asTenant(provisioned.connectionUri, "/kept")
    // The same URI, and the document is still there — a suspension that lost data would not be one.
    expect(restored.status).toBe(200)
  }, 60_000)

  it("invalidates the old URI on rotation", async () => {
    const driver = couchDbDriver(db, config!)
    const { backendServiceId, organizationId } = await service("Rotatable")

    const first = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Rotatable",
    })
    const second = await driver.rotateCredentials(backendServiceId)

    expect(second).not.toBe(first.connectionUri)
    expect((await asTenant(first.connectionUri, "")).status).toBe(401)
    expect((await asTenant(second, "")).status).toBe(200)
  }, 60_000)

  it("removes the database and the user on teardown", async () => {
    const driver = couchDbDriver(db, config!)
    const { backendServiceId, organizationId } = await service("Doomed")

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Doomed" })
    await driver.destroy(backendServiceId)

    const url = new URL(config!.adminUrl)
    const admin = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, "utf8").toString("base64")}`

    const database = await fetch(`${url.origin}/${databaseNameFor(backendServiceId)}`, {
      headers: { Authorization: admin },
    })
    expect(database.status).toBe(404)
  }, 60_000)
})
