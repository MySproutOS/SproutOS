import { encodeShortId, tenantIndexPrefix, tenantUsername } from "@lib/services/tenant-auth"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { reconcileSearchSecurity } from "./reconcile-search"
import { searchAdminConfigFromEnv, searchAdminRequest } from "./search"

const config = (() => {
  try {
    return searchAdminConfigFromEnv()
  } catch {
    return undefined
  }
})()
const rootKey = process.env.SEARCH_PROXY_SECURITY_ROOT_KEY ?? ""
const reachable = await (async () => {
  if (config === undefined || rootKey === "") return false
  try {
    await searchAdminRequest(config, "GET", "/")
    await db.selectFrom("region").select("id").limit(1).executeTakeFirstOrThrow()
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

describe.skipIf(!reachable)("OpenSearch Security reconciliation", () => {
  const userId = v7()
  const organizationId = v7()
  const serviceId = v7()
  const orphanId = v7()
  const prefix = tenantIndexPrefix(serviceId)
  const username = tenantUsername({ organizationId, kind: "searchIndex", resourceId: serviceId })
  const role = `tenant_${prefix.replace(/_$/, "")}`
  const orphanRole = `tenant_t${encodeShortId(orphanId)}`

  beforeAll(async () => {
    const region = await db
      .selectFrom("region")
      .select("id")
      .orderBy("id", "asc")
      .executeTakeFirstOrThrow()
    await db
      .insertInto("user")
      .values({ id: userId, email: `search-reconcile-${userId}@example.invalid` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        name: "Search reconcile",
        slug: `search-reconcile-${organizationId.slice(-12)}`,
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
        kind: "elasticsearch",
        name: "search",
        regionId: region.id,
        status: "active",
      })
      .execute()

    // A name shaped like ours is still not proof it belongs to a live or deleted service. The
    // reconciler must report this document and leave it for an operator/the deletion reaper.
    await searchAdminRequest(config!, "PUT", `/_plugins/_security/api/roles/${orphanRole}`, {
      cluster_permissions: [],
      index_permissions: [],
      tenant_permissions: [],
    })
    await searchAdminRequest(config!, "PUT", `/_plugins/_security/api/rolesmapping/${orphanRole}`, {
      backend_roles: [],
      hosts: [],
      users: [],
    })
  })

  afterAll(async () => {
    await Promise.all(
      [
        ["internalusers", username],
        ["rolesmapping", role],
        ["roles", role],
        ["rolesmapping", orphanRole],
        ["roles", orphanRole],
      ].map(async ([endpoint, name]) =>
        searchAdminRequest(
          config!,
          "DELETE",
          `/_plugins/_security/api/${endpoint}/${encodeURIComponent(name)}`,
        ).catch(() => undefined),
      ),
    )
    await db.deleteFrom("backendService").where("id", "=", serviceId).execute()
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
  })

  it("repairs missing and drifted documents, reports cardinality, and preserves unknown documents", async () => {
    const first = await reconcileSearchSecurity(db, config!, rootKey, 1, 2)
    expect(first.missing.roles).toBeGreaterThanOrEqual(1)
    expect(first.missing.users).toBeGreaterThanOrEqual(1)
    expect(first.missing.mappings).toBeGreaterThanOrEqual(1)
    expect(first.repaired.roles).toBeGreaterThanOrEqual(1)
    expect(first.orphaned.roles).toBeGreaterThanOrEqual(1)
    expect(first.orphaned.mappings).toBeGreaterThanOrEqual(1)
    expect(first.softLimitExceeded).toBe(true)
    expect(first.pendingRepairs).toBeGreaterThanOrEqual(1)
    expect(first.listLatencyMs).toBeGreaterThanOrEqual(0)

    const createdUser = await searchAdminRequest<Record<string, Record<string, unknown>>>(
      config!,
      "GET",
      `/_plugins/_security/api/internalusers/${encodeURIComponent(username)}`,
    )
    expect(createdUser[username]?.backend_roles).toEqual([role])
    expect(createdUser[username]?.attributes).toMatchObject({ sproutos_managed: "search-v1" })

    await searchAdminRequest(config!, "PUT", `/_plugins/_security/api/roles/${role}`, {
      cluster_permissions: ["*"],
      index_permissions: [{ index_patterns: ["*"], allowed_actions: ["*"] }],
      tenant_permissions: [],
    })
    const second = await reconcileSearchSecurity(db, config!, rootKey, 1_000, 1)
    expect(second.drifted.roles).toBeGreaterThanOrEqual(1)
    const repairedRole = await searchAdminRequest<Record<string, Record<string, unknown>>>(
      config!,
      "GET",
      `/_plugins/_security/api/roles/${role}`,
    )
    expect(repairedRole[role]?.cluster_permissions).toEqual(["cluster_composite_ops"])
    expect(
      await searchAdminRequest<Record<string, unknown>>(
        config!,
        "GET",
        `/_plugins/_security/api/roles/${orphanRole}`,
      ),
    ).toHaveProperty(orphanRole)
  }, 20_000)
})
