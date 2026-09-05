import { provisionOrganization } from "@lib/dao"
import { hashGeneratedSecret, lastFour, tenantCredential } from "@lib/services"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import app from "../index"
import { authHeaders, cleanupFixtures, createTestUser, trackOrganization } from "../test/fixtures"
import { SERVICE_KINDS } from "./services.serializer"
import {
  connectionEnvironmentEntries,
  connectionResponse,
  hasProvisioningCredit,
  servicePublicEndpoint,
  withQueueLifecycleLock,
} from "./services"

describe("service connection contracts", () => {
  it("requires a positive spendable balance before provisioning", () => {
    expect(hasProvisioningCredit(-1n)).toBe(false)
    expect(hasProvisioningCredit(0n)).toBe(false)
    expect(hasProvisioningCredit(1n)).toBe(true)
  })
  it("adds BullMQ's prefix only for Valkey", () => {
    expect(
      connectionEnvironmentEntries({
        connectionUri: "redis://tenant@example.test:6379",
        keyPrefix: "{kv:abc}:bull",
        kind: "valkey",
      }),
    ).toEqual([
      { isSecret: true, key: "REDIS_URL", value: "redis://tenant@example.test:6379" },
      { isSecret: true, key: "VALKEY_URL", value: "redis://tenant@example.test:6379" },
      { isSecret: false, key: "BULLMQ_PREFIX", value: "{kv:abc}:bull" },
    ])
  })

  it("leaves non-Valkey response and environment shapes unchanged", () => {
    const result = { connectionUri: "postgresql://tenant@example.test/database" }
    expect(JSON.stringify(connectionResponse("service-id", result))).toBe(
      '{"id":"service-id","connectionUri":"postgresql://tenant@example.test/database"}',
    )
    expect(connectionEnvironmentEntries({ ...result, kind: "postgres" })).toEqual([
      {
        isSecret: true,
        key: "DATABASE_URL",
        value: "postgresql://tenant@example.test/database",
      },
    ])
  })

  it("writes every S3 field an attached project needs from the object-storage URI", () => {
    expect(
      connectionEnvironmentEntries({
        connectionUri:
          "sls+s3://SPROUTKEY:secret%3Avalue@storage.example.com?endpoint=https%3A%2F%2Fstorage.example.com&bucket=v-tenant&region=us-east-1",
        kind: "object_storage",
      }),
    ).toEqual([
      { isSecret: false, key: "S3_ENDPOINT", value: "https://storage.example.com" },
      { isSecret: false, key: "S3_REGION", value: "us-east-1" },
      { isSecret: false, key: "S3_BUCKET_NAME", value: "v-tenant" },
      { isSecret: false, key: "S3_FORCE_PATH_STYLE", value: "true" },
      { isSecret: true, key: "S3_ACCESS_KEY_ID", value: "SPROUTKEY" },
      { isSecret: true, key: "S3_SECRET_ACCESS_KEY", value: "secret:value" },
    ])
  })

  it("shows each active service at its public proxy rather than a Postgres provider host", () => {
    const env = {
      SERVICE_POSTGRES_PUBLIC_HOST: "postgres.sproutos.test",
      SERVICE_POSTGRES_PUBLIC_PORT: "5432",
      SERVICE_VALKEY_PUBLIC_HOST: "valkey.sproutos.test",
      SERVICE_VALKEY_PUBLIC_PORT: "6379",
      SERVICE_SEARCH_PUBLIC_HOST: "search.sproutos.test",
      SERVICE_SEARCH_PUBLIC_PORT: "443",
      SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT: "https://storage.sproutos.test",
    }

    expect(servicePublicEndpoint("postgres", "active", env)).toEqual({
      host: "postgres.sproutos.test",
      port: 5432,
    })
    expect(servicePublicEndpoint("valkey", "active", env)).toEqual({
      host: "valkey.sproutos.test",
      port: 6379,
    })
    expect(servicePublicEndpoint("elasticsearch", "active", env)).toEqual({
      host: "search.sproutos.test",
      port: 443,
    })
    expect(servicePublicEndpoint("object_storage", "active", env)).toEqual({
      host: "storage.sproutos.test",
      port: 443,
    })
  })

  it("keeps unfinished, unsupported, or malformed endpoints out of the list", () => {
    expect(
      servicePublicEndpoint("valkey", "provisioning", {
        SERVICE_VALKEY_PUBLIC_HOST: "valkey.sproutos.test",
      }),
    ).toEqual({ host: null, port: null })
    expect(servicePublicEndpoint("object_storage", "active", {})).toEqual({
      host: null,
      port: null,
    })
    expect(
      servicePublicEndpoint("elasticsearch", "active", {
        SERVICE_SEARCH_PUBLIC_HOST: "search.sproutos.test",
        SERVICE_SEARCH_PUBLIC_PORT: "not-a-port",
      }),
    ).toEqual({ host: null, port: null })
  })
})

/**
 * What the API accepts and what the database accepts have to be the same list.
 *
 * They are declared in two places — `SERVICE_KINDS` here and `backend_service_kind_check` in a
 * migration — and a kind in one and not the other fails in one of two ways, neither of which names
 * the cause: a kind the API rejects that the database would have taken is a 400 for something that
 * would have worked, and a kind the API takes that the database refuses is a constraint violation
 * surfacing as a 500.
 *
 * Read from `pg_constraint` rather than restated, for the reason `sandbox_state_check` earned the
 * hard way: a second copy of an enum is a second thing to forget.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

afterAll(async () => {
  if (reachable) await cleanupFixtures()
})

describe.runIf(reachable)("object-storage credential reveal", () => {
  it("reconstructs the active credential only for an interactive organization member", async () => {
    const user = await createTestUser("storage-reveal")
    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: user.name,
      email: user.email,
    })
    trackOrganization(organization.id)
    const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
    const serviceId = v7()
    const credential = await tenantCredential(
      process.env.SERVICE_OBJECT_STORAGE_ROOT_KEY!,
      serviceId,
      1,
    )

    await db
      .insertInto("backendService")
      .values({
        id: serviceId,
        organizationId: organization.id,
        projectId: null,
        regionId: region.id,
        name: "SDK media",
        kind: "object_storage",
        status: "active",
      })
      .execute()
    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: serviceId,
        databaseBranchId: null,
        oauthGrantId: null,
        username: credential.accessKeyId,
        secretHash: await hashGeneratedSecret(credential.secretAccessKey),
        lastFour: lastFour(credential.secretAccessKey),
      })
      .execute()

    const response = await app.request(
      `/v1/orgs/${organization.slug}/services/${serviceId}/connection`,
      { headers: authHeaders(user) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as { id: string; connectionUri: string }
    expect(body.id).toBe(serviceId)
    expect(body.connectionUri).toContain(encodeURIComponent(credential.accessKeyId))
    expect(body.connectionUri).toContain(encodeURIComponent(credential.secretAccessKey))
  })

  it("changes and lists the service-level public-read default", async () => {
    const user = await createTestUser("storage-public-read")
    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: user.name,
      email: user.email,
    })
    trackOrganization(organization.id)
    const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
    const serviceId = v7()
    await db
      .insertInto("backendService")
      .values({
        id: serviceId,
        organizationId: organization.id,
        projectId: null,
        regionId: region.id,
        name: "Public media",
        kind: "object_storage",
        status: "active",
      })
      .execute()

    const updated = await app.request(
      `/v1/orgs/${organization.slug}/services/${serviceId}/object-storage-access`,
      {
        method: "PATCH",
        headers: { ...authHeaders(user), "Content-Type": "application/json" },
        body: JSON.stringify({ publicRead: true }),
      },
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ id: serviceId, publicRead: true })

    const listed = await app.request(`/v1/orgs/${organization.slug}/services`, {
      headers: authHeaders(user),
    })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { data: { id: string; publicRead: boolean | null }[] }
    expect(body.data.find((service) => service.id === serviceId)?.publicRead).toBe(true)
  })
})

async function allowedKinds(): Promise<string[]> {
  const rows = await sql<{ def: string }>`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'backend_service'::regclass and conname = 'backend_service_kind_check'
  `.execute(db)

  const definition = rows.rows[0]?.def ?? ""
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort()
}

describe.runIf(reachable)("the backend service kinds", () => {
  it("serializes attached queue mutation with deployment publication", async () => {
    const projectId = crypto.randomUUID()
    let entered = false

    await db.connection().execute(async (connection) => {
      const key = `sproutos:project:${projectId}`
      await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`.execute(connection)
      const mutation = withQueueLifecycleLock(
        { id: crypto.randomUUID(), kind: "valkey", projectId },
        () => {
          entered = true
          return Promise.resolve()
        },
      )

      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(entered).toBe(false)
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection)
      await mutation
    })

    expect(entered).toBe(true)
  }, 10_000)

  it("match the constraint, in both directions", async () => {
    expect(await allowedKinds()).toEqual([...SERVICE_KINDS].sort())
  })

  it("includes the kinds added after the first three", async () => {
    // Named specifically because the original three were added at once and these came later, which
    // is the case where a list and a constraint drift apart.
    // As a map so a failure names the kind that is missing and from which side. `expect(x, label)`
    // would be the obvious way to say that and vitest's matcher takes one argument.
    const allowed = new Set(await allowedKinds())
    const declared = new Set<string>(SERVICE_KINDS)

    expect({
      object_storage: {
        constraint: allowed.has("object_storage"),
        api: declared.has("object_storage"),
      },
      // Withdrawn: it was exposed directly to tenants, which is not how any other datastore here
      // works. See the `drop_couchdb_kind` migration.
      couchdb: { constraint: allowed.has("couchdb"), api: declared.has("couchdb") },
    }).toEqual({
      object_storage: { constraint: true, api: true },
      couchdb: { constraint: false, api: false },
    })
  })
})
