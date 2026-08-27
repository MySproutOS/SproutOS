import { tenantIndexPrefix, tenantUsername } from "@lib/services/tenant-auth"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  purgeTenantIndices,
  purgeTenantSearch,
  searchAdminRequest,
  type SearchAdminConfig,
} from "./search"
import { reapDeletedOrganizations, reapDeletedServices } from "./reap"
import { purgeTenantKeys, tenantKeyPrefix } from "./valkey"

/*
  The *tail* of a UUIDv7, not the head.

  A v7 is 48 bits of millisecond timestamp followed by random bits, so `slice(0, 8)` is pure clock:
  two ids minted in the same millisecond share it exactly. That is not hypothetical — it made this
  suite fail roughly one run in three with
  `duplicate key value violates unique constraint "organization_slug_live_key"`, from a value chosen
  precisely because it was supposed to be unique.

  The last twelve characters are the random half.
*/

/**
 * Runs against the compose Valkey and OpenSearch.
 *
 * Every claim this module makes is a claim about another system's behaviour — that `SCAN MATCH`
 * finds a hash-tagged key, that `_cat/indices` answers with an empty array rather than a 404 for a
 * prefix nothing matches, that deleting an index is visible to the next request. A mock would
 * assert my reading of the documentation, which is exactly the thing most likely to be wrong about
 * a reaper: it is the code path nobody watches, and the failure mode is data that quietly stays.
 */
const valkeyUrl = process.env.SERVICE_VALKEY_ADMIN_URL ?? process.env.VALKEY_URL ?? ""
const searchUrl = process.env.SEARCH_ADMIN_URL ?? process.env.SEARCH_PROXY_UPSTREAM ?? ""
const search: SearchAdminConfig = {
  url: searchUrl.replace(/\/+$/, ""),
  ...(process.env.SEARCH_ADMIN_USER === undefined
    ? {}
    : { username: process.env.SEARCH_ADMIN_USER }),
  ...(process.env.SEARCH_ADMIN_PASSWORD === undefined
    ? {}
    : { password: process.env.SEARCH_ADMIN_PASSWORD }),
}

let redis: Redis | undefined

const valkeyUp = await reachable(valkeyUrl !== "", async () => {
  redis = new Redis(valkeyUrl, { maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect()
  await redis.ping()
})

const searchUp = await reachable(searchUrl !== "", async () => {
  const response = await searchFetch("/")
  if (!response.ok) throw new Error(`OpenSearch answered ${response.status}`)
})

/**
 * A store being absent must fail in CI and skip locally.
 *
 * A reaper test that silently skips reads as a pass in the summary, and the thing it would have
 * caught is a deletion that does not delete — which nobody notices until a customer asks whether
 * their data is gone and the honest answer is "some of it".
 */
async function reachable(configured: boolean, probe: () => Promise<void>): Promise<boolean> {
  if (!configured) {
    if (process.env.CI !== undefined) {
      throw new Error("A store is unconfigured in CI; the reaper tests must not silently skip here")
    }
    return false
  }
  try {
    await probe()
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
}

afterAll(async () => {
  await redis?.quit()
})

/** The connection, for the suites that only run when it exists. Throwing beats `as Redis`: if the
 * skip conditions ever stop lining up, the test fails loudly rather than on a null dereference. */
function client(): Redis {
  if (redis === undefined)
    throw new Error("Valkey is not reachable; this suite should have skipped")
  return redis
}

describe.skipIf(!valkeyUp)("purging a tenant's Valkey keys", () => {
  it("deletes everything under the namespace and nothing outside it", async () => {
    const mine = v7()
    const theirs = v7()

    // Deliberately the shapes a real tenant's BullMQ leaves behind — a hash, a sorted set, a list —
    // because `UNLINK` takes any type and a reaper that only handled strings would look like it
    // worked on an empty queue.
    await client().hset(`${tenantKeyPrefix(mine)}bull:emails:1`, "data", "{}")
    await client().zadd(`${tenantKeyPrefix(mine)}bull:emails:delayed`, 1, "1")
    await client().rpush(`${tenantKeyPrefix(mine)}bull:emails:wait`, "1")
    await client().set(`${tenantKeyPrefix(theirs)}bull:emails:1`, "not yours")

    const result = await purgeTenantKeys(client(), mine)

    expect(result.deleted).toBe(3)
    expect(await client().keys(`${tenantKeyPrefix(mine)}*`)).toEqual([])
    // The whole point. A reaper that took the neighbours with it would pass every test that only
    // looked at the tenant being deleted.
    expect(await client().get(`${tenantKeyPrefix(theirs)}bull:emails:1`)).toBe("not yours")

    await client().unlink(`${tenantKeyPrefix(theirs)}bull:emails:1`)
  })

  it("is a no-op for a tenant that never wrote anything", async () => {
    const result = await purgeTenantKeys(client(), v7())
    expect(result.deleted).toBe(0)
  })
})

describe.skipIf(!valkeyUp)("reaping a Valkey service", () => {
  const organizationId = v7()
  const userId = v7()
  const serviceId = v7()
  const username = tenantUsername({
    organizationId,
    kind: "queue",
    resourceId: serviceId,
  })

  beforeAll(async () => {
    const region = await db
      .selectFrom("region")
      .select("id")
      .orderBy("id", "asc")
      .executeTakeFirstOrThrow()

    await db
      .insertInto("user")
      .values({ id: userId, email: `reaper-valkey-${userId}@example.invalid` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Valkey Reaper",
        slug: `reaper-valkey-${organizationId.slice(-12)}`,
        kind: "team",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("backendService")
      .values({
        id: serviceId,
        organizationId,
        projectId: null,
        kind: "valkey",
        name: "queue",
        regionId: region.id,
        status: "deleting",
        deletedAt: new Date(),
      })
      .execute()
  })

  afterAll(async () => {
    await client().call("ACL", "DELUSER", username)
    await db.deleteFrom("backendService").where("id", "=", serviceId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  })

  it("closes the tenant connection before it stamps the service purged", async () => {
    const password = "reaper-live-session-password"
    await client().call("ACL", "SETUSER", username, "reset", "on", `>${password}`, "+PING")
    const tenant = new Redis(valkeyUrl, {
      enableReadyCheck: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      password,
      retryStrategy: () => null,
      username,
    })
    tenant.on("error", () => {})
    await tenant.connect()
    expect(await tenant.ping()).toBe("PONG")

    const ended = new Promise<void>((resolve) =>
      tenant.once("end", () => {
        resolve()
      }),
    )
    const result = await reapDeletedServices(db, { valkeyUrl, search, logs: false })
    await Promise.race([
      ended,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Valkey did not close the reaped ACL session"))
        }, 2_000)
      }),
    ])

    expect(result).toContainEqual({ backendServiceId: serviceId, kind: "valkey", removed: 0 })
    expect(
      (
        await db
          .selectFrom("backendService")
          .select("purgedAt")
          .where("id", "=", serviceId)
          .executeTakeFirstOrThrow()
      ).purgedAt,
    ).not.toBeNull()
  })
})

describe.skipIf(!searchUp)("purging a tenant's indices", () => {
  it("deletes every index under the prefix and nothing outside it", async () => {
    const mine = v7()
    const mineOrganization = v7()
    const theirs = v7()
    const username = tenantUsername({
      organizationId: mineOrganization,
      kind: "searchIndex",
      resourceId: mine,
    })
    const role = `tenant_${tenantIndexPrefix(mine).replace(/_$/, "")}`

    await createIndex(`${tenantIndexPrefix(mine)}products`)
    await createIndex(`${tenantIndexPrefix(mine)}orders`)
    await createIndex(`${tenantIndexPrefix(theirs)}products`)
    await createSecurityIdentity(username, role, tenantIndexPrefix(mine))

    const deleted = await purgeTenantSearch(search, tenantIndexPrefix(mine), username)

    expect(deleted.sort()).toEqual(
      [`${tenantIndexPrefix(mine)}orders`, `${tenantIndexPrefix(mine)}products`].sort(),
    )
    expect(await indexExists(`${tenantIndexPrefix(mine)}products`)).toBe(false)
    expect(await indexExists(`${tenantIndexPrefix(theirs)}products`)).toBe(true)
    expect(await securityResourceStatus(`internalusers/${encodeURIComponent(username)}`)).toBe(404)
    expect(await securityResourceStatus(`rolesmapping/${encodeURIComponent(role)}`)).toBe(404)
    expect(await securityResourceStatus(`roles/${encodeURIComponent(role)}`)).toBe(404)

    await purgeTenantIndices(search, tenantIndexPrefix(theirs))
  }, 20_000)

  it("succeeds for a tenant that never indexed anything", async () => {
    // `_cat/indices/nomatch*` is a 200 with an empty array, not a 404 — asserted because the
    // opposite would make every clean deletion throw, and every clean deletion is most of them.
    expect(await purgeTenantIndices(search, tenantIndexPrefix(v7()))).toEqual([])
  })

  it("refuses an empty prefix", async () => {
    // A prefix that came back empty because a short id failed to encode would delete the cluster.
    await expect(purgeTenantIndices(search, "")).rejects.toThrow(RangeError)
  })
})

describe.skipIf(!valkeyUp || !searchUp)("the reaper pass", () => {
  const organizationId = v7()
  const userId = v7()
  const serviceId = v7()
  const searchServiceId = v7()

  beforeAll(async () => {
    // `region_id` is not null, and the regions are reference data the seeds create. Reading one
    // rather than inventing one keeps this test honest about what a real row looks like.
    const region = await db
      .selectFrom("region")
      .select("id")
      .orderBy("id", "asc")
      .executeTakeFirstOrThrow()

    await db
      .insertInto("user")
      .values({ id: userId, email: `reaper-${userId}@example.invalid` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Reaper",
        slug: `reaper-${organizationId.slice(-12)}`,
        kind: "team",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("backendService")
      .values({
        id: serviceId,
        organizationId,
        projectId: null,
        kind: "valkey",
        name: "queue",
        regionId: region.id,
        status: "deleting",
        deletedAt: new Date(),
      })
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("backendService").where("id", "=", searchServiceId).execute()
    await db.deleteFrom("backendService").where("id", "=", serviceId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  })

  it("purges a deleted service's keys and stamps it so it is not seen again", async () => {
    await client().set(`${tenantKeyPrefix(serviceId)}bull:jobs:1`, "{}")

    const first = await reapDeletedServices(db, { valkeyUrl, search, logs: false })
    const reaped = first.find((row) => row.backendServiceId === serviceId)

    expect(reaped).toEqual({ backendServiceId: serviceId, kind: "valkey", removed: 1 })
    expect(await client().keys(`${tenantKeyPrefix(serviceId)}*`)).toEqual([])

    /*
      The stamp is the whole reason `purged_at` exists. Without it the pass would re-purge every
      deleted service on every run — an hourly `SCAN` of the entire keyspace per deleted tenant,
      forever.
    */
    const second = await reapDeletedServices(db, { valkeyUrl, search, logs: false })
    expect(second.some((row) => row.backendServiceId === serviceId)).toBe(false)
  })

  it("purges a deleted search service's indices and Security identity before stamping it", async () => {
    const region = await db
      .selectFrom("region")
      .select("id")
      .orderBy("id", "asc")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("backendService")
      .values({
        id: searchServiceId,
        organizationId,
        projectId: null,
        kind: "elasticsearch",
        name: "search",
        regionId: region.id,
        status: "deleting",
        deletedAt: new Date(),
      })
      .execute()

    const prefix = tenantIndexPrefix(searchServiceId)
    const username = tenantUsername({
      organizationId,
      kind: "searchIndex",
      resourceId: searchServiceId,
    })
    const role = `tenant_${prefix.replace(/_$/, "")}`
    await createIndex(`${prefix}documents`)
    await createSecurityIdentity(username, role, prefix)

    const result = await reapDeletedServices(db, { valkeyUrl, search, logs: false })
    expect(result).toContainEqual({
      backendServiceId: searchServiceId,
      kind: "elasticsearch",
      removed: 1,
    })
    expect(await indexExists(`${prefix}documents`)).toBe(false)
    expect(await securityResourceStatus(`internalusers/${encodeURIComponent(username)}`)).toBe(404)
    expect(await securityResourceStatus(`rolesmapping/${encodeURIComponent(role)}`)).toBe(404)
    expect(await securityResourceStatus(`roles/${encodeURIComponent(role)}`)).toBe(404)
    expect(
      (
        await db
          .selectFrom("backendService")
          .select("purgedAt")
          .where("id", "=", searchServiceId)
          .executeTakeFirstOrThrow()
      ).purgedAt,
    ).not.toBeNull()
  })

  it("will not stamp an organization while one of its services is unpurged", async () => {
    await db
      .updateTable("organization")
      .set({ deletedAt: new Date() })
      .where("id", "=", organizationId)
      .execute()

    // Put the service back in the queue: the organization must wait for it.
    await db
      .updateTable("backendService")
      .set({ purgedAt: null })
      .where("id", "=", serviceId)
      .execute()

    expect(await reapDeletedOrganizations(db, { valkeyUrl, search, logs: false })).not.toContain(
      organizationId,
    )

    await reapDeletedServices(db, { valkeyUrl, search, logs: false })

    expect(await reapDeletedOrganizations(db, { valkeyUrl, search, logs: false })).toContain(
      organizationId,
    )
  })
})

async function createIndex(name: string): Promise<void> {
  const response = await searchFetch(`/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    // One shard, no replica: a single-node cluster leaves a replica unassigned and the index yellow
    // forever, which is noise in every later `_cat` call.
    body: JSON.stringify({ settings: { number_of_shards: 1, number_of_replicas: 0 } }),
  })
  if (!response.ok) throw new Error(`Could not create ${name}: ${await response.text()}`)
}

async function indexExists(name: string): Promise<boolean> {
  return (await searchFetch(`/${name}`, { method: "HEAD" })).status === 200
}

async function createSecurityIdentity(
  username: string,
  role: string,
  prefix: string,
): Promise<void> {
  await securityPut(`roles/${encodeURIComponent(role)}`, {
    cluster_permissions: ["cluster_composite_ops"],
    index_permissions: [{ index_patterns: [`${prefix}*`], allowed_actions: ["read", "write"] }],
    tenant_permissions: [],
  })
  await securityPut(`internalusers/${encodeURIComponent(username)}`, {
    password: "Test-only-search-user-password-73!",
    backend_roles: [role],
    attributes: {},
  })
  await securityPut(`rolesmapping/${encodeURIComponent(role)}`, {
    backend_roles: [role],
    hosts: [],
    users: [username],
  })
}

async function securityPut(path: string, body: unknown): Promise<void> {
  // Setup mutates the same Security config document as every parallel test. Exercise the
  // production helper so its bounded 409 retry protects the fixture too; a bespoke fetch here was
  // the last unbounded writer and failed CI while every product path was already fixed.
  await searchAdminRequest(search, "PUT", `/_plugins/_security/api/${path}`, body)
}

async function securityResourceStatus(path: string): Promise<number> {
  return (await searchFetch(`/_plugins/_security/api/${path}`)).status
}

/** Use the same admin identity as the reaper itself for setup, probes, and assertions. */
async function searchFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (search.username !== undefined) {
    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${search.username}:${search.password ?? ""}`).toString("base64")}`,
    )
  }
  return fetch(`${search.url}${path}`, { ...init, headers })
}
