import { tenantIndexPrefix } from "@lib/services/tenant-auth"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { purgeTenantIndices, type SearchAdminConfig } from "./search"
import { reapDeletedOrganizations, reapDeletedServices } from "./reap"
import { purgeTenantKeys, tenantKeyPrefix } from "./valkey"

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
const search: SearchAdminConfig = { url: searchUrl.replace(/\/+$/, "") }

let redis: Redis | undefined

const valkeyUp = await reachable(valkeyUrl !== "", async () => {
  redis = new Redis(valkeyUrl, { maxRetriesPerRequest: 1, lazyConnect: true })
  await redis.connect()
  await redis.ping()
})

const searchUp = await reachable(searchUrl !== "", async () => {
  const response = await fetch(`${search.url}/`)
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

describe.skipIf(!searchUp)("purging a tenant's indices", () => {
  it("deletes every index under the prefix and nothing outside it", async () => {
    const mine = v7()
    const theirs = v7()

    await createIndex(`${tenantIndexPrefix(mine)}products`)
    await createIndex(`${tenantIndexPrefix(mine)}orders`)
    await createIndex(`${tenantIndexPrefix(theirs)}products`)

    const deleted = await purgeTenantIndices(search, tenantIndexPrefix(mine))

    expect(deleted.sort()).toEqual(
      [`${tenantIndexPrefix(mine)}orders`, `${tenantIndexPrefix(mine)}products`].sort(),
    )
    expect(await indexExists(`${tenantIndexPrefix(mine)}products`)).toBe(false)
    expect(await indexExists(`${tenantIndexPrefix(theirs)}products`)).toBe(true)

    await purgeTenantIndices(search, tenantIndexPrefix(theirs))
  })

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
        slug: `reaper-${organizationId.slice(0, 8)}`,
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
  const response = await fetch(`${search.url}/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    // One shard, no replica: a single-node cluster leaves a replica unassigned and the index yellow
    // forever, which is noise in every later `_cat` call.
    body: JSON.stringify({ settings: { number_of_shards: 1, number_of_replicas: 0 } }),
  })
  if (!response.ok) throw new Error(`Could not create ${name}: ${await response.text()}`)
}

async function indexExists(name: string): Promise<boolean> {
  return (await fetch(`${search.url}/${name}`, { method: "HEAD" })).status === 200
}
