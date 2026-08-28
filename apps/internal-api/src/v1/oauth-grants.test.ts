import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * Withdrawing consent, and what happens to the databases an application created.
 *
 * The property under test is the one the feature exists for: an application that provisioned a
 * database on a user's behalf must lose access to it when the user revokes, **and the user must
 * not**. Those two are in tension — the application minted the only credential — which is why
 * keeping a database rotates it rather than leaving it alone.
 */
const reachable = await databaseReachable()

type Json = Record<string, unknown>

let owner: TestUser | undefined
let orgSlug = ""
let organizationId = ""
let clientId = ""

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: { ...authHeaders(user), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

/**
 * A grant, plus a service and a credential attributed to it, as provisioning would leave them.
 *
 * A client of its own each time, because `oauth_grant_live_key` allows one live grant per
 * client/user/organization — which is the right rule (authorizing an app twice is one consent, not
 * two) and means a fixture reusing one client can only ever build a single grant.
 */
async function grantWithDatabase(): Promise<{ grantId: string; serviceId: string }> {
  const ownClientId = v7()
  await db
    .insertInto("oauthClient")
    .values({
      id: ownClientId,
      ownerUserId: owner!.id,
      organizationId,
      name: `App ${ownClientId.slice(-6)}`,
      homepageUrl: "https://notes.example.com",
      clientType: "confidential",
      defaultScopes: ["database:create"],
      isFirstParty: false,
    })
    .execute()

  const grantId = v7()
  await db
    .insertInto("oauthGrant")
    .values({
      id: grantId,
      oauthClientId: ownClientId,
      userId: owner!.id,
      organizationId,
      scopes: ["database:create", "database:read"],
    })
    .execute()

  const region = await db.selectFrom("region").select("id").orderBy("id").executeTakeFirst()

  const serviceId = v7()
  await db
    .insertInto("backendService")
    .values({
      id: serviceId,
      organizationId,
      projectId: null,
      regionId: region!.id,
      name: `db-${serviceId.slice(-6)}`,
      kind: "valkey",
      status: "active",
      createdByOauthGrantId: grantId,
    })
    .execute()

  await db
    .insertInto("serviceCredential")
    .values({
      id: v7(),
      backendServiceId: serviceId,
      username: `kv_${serviceId.replaceAll("-", "").slice(-20)}`,
      secretHash: `sha256$${"0".repeat(64)}`,
      lastFour: "abcd",
      oauthGrantId: grantId,
    })
    .execute()

  return { grantId, serviceId }
}

async function liveCredentials(serviceId: string) {
  return await db
    .selectFrom("serviceCredential")
    .select(["id", "oauthGrantId", "revokedAt"])
    .where("backendServiceId", "=", serviceId)
    .where("revokedAt", "is", null)
    .execute()
}

/*
  Each suite makes its own organization through the API.

  `createTestUser` gives a user and not an organization, so an org-scoped route answers
  "Organization not found" — which reads exactly like a broken route and is not one.
*/
async function makeOrg(user: TestUser, name: string): Promise<{ id: string; slug: string }> {
  const created = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: `${name} ${v7()}` }),
  })
  const organization = (await created.json()) as Json
  trackOrganization(organization.id as string)
  return { id: organization.id as string, slug: organization.slug as string }
}

beforeAll(async () => {
  if (!reachable) return
  owner = await createTestUser("grants-owner")
  const org = await makeOrg(owner, "OAuth Grants Suite")
  organizationId = org.id
  orgSlug = org.slug

  clientId = v7()
  await db
    .insertInto("oauthClient")
    .values({
      id: clientId,
      ownerUserId: owner.id,
      organizationId,
      name: "A note-taking app",
      homepageUrl: "https://notes.example.com",
      clientType: "confidential",
      defaultScopes: ["database:create"],
      // `oauth_client_ownership_check`: a third-party client carries both an owner and an
      // organization, and a first-party one carries neither.
      isFirstParty: false,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!reachable)("authorized applications", () => {
  it("lists what an application created, so revoking can ask about it", async ({ skip }) => {
    if (!reachable) skip()
    const { grantId, serviceId } = await grantWithDatabase()

    const listed = await call("GET", `/v1/orgs/${orgSlug}/oauth-grants`, owner!)
    expect(listed.status).toBe(200)

    const grants = listed.json.data as Json[]
    const mine = grants.find((grant) => grant.id === grantId)
    expect(mine, "the grant must be listed").toBeDefined()
    expect(String(mine!.clientName)).toMatch(/^App /)
    expect((mine!.services as Json[]).map((s) => s.id)).toEqual([serviceId])
  })

  /*
    The whole point, asserted at the row the proxies read.

    Every split authenticates by looking up `service_credential` where `revoked_at is null` —
    `lib/rust/service-credentials` is the only implementation and all three go through it. So
    "the application can no longer reach the database" is exactly "no live credential carries its
    grant", and that is what this checks rather than reaching for a proxy.
  */
  it("kills the application's database credential and hands the user a new one", async ({
    skip,
  }) => {
    if (!reachable) skip()
    const { grantId, serviceId } = await grantWithDatabase()

    const before = await liveCredentials(serviceId)
    expect(before).toHaveLength(1)
    expect(before[0]?.oauthGrantId).toBe(grantId)

    const revoked = await call(
      "POST",
      `/v1/orgs/${orgSlug}/oauth-grants/${grantId}/revoke`,
      owner!,
      { services: [{ id: serviceId, action: "keep" }] },
    )
    // The body is asserted rather than passed as a message, so a failure still says what came back.
    expect({ status: revoked.status, body: revoked.json }).toMatchObject({ status: 200 })

    const kept = revoked.json.kept as Json[]
    expect(kept).toHaveLength(1)
    expect(String(kept[0]?.connectionUri)).toContain("://")

    const after = await liveCredentials(serviceId)
    expect(after, "exactly one live credential after rotation").toHaveLength(1)
    // The application's is gone; what remains belongs to nobody but the user.
    expect(after[0]?.oauthGrantId).toBeNull()
    expect(after[0]?.id).not.toBe(before[0]?.id)

    // And the service is no longer attributed to an application it has been taken back from.
    const service = await db
      .selectFrom("backendService")
      .select(["createdByOauthGrantId", "deletedAt"])
      .where("id", "=", serviceId)
      .executeTakeFirst()
    expect(service?.createdByOauthGrantId).toBeNull()
    expect(service?.deletedAt).toBeNull()
  })

  it("does not rotate an existing user credential when revoking the app", async ({ skip }) => {
    if (!reachable) skip()
    const { grantId, serviceId } = await grantWithDatabase()
    const appCredential = await db
      .selectFrom("serviceCredential")
      .select("username")
      .where("backendServiceId", "=", serviceId)
      .executeTakeFirstOrThrow()
    const userCredentialId = v7()
    await db
      .insertInto("serviceCredential")
      .values({
        id: userCredentialId,
        backendServiceId: serviceId,
        username: appCredential.username,
        secretHash: `sha256$${"1".repeat(64)}`,
        lastFour: "user",
        oauthGrantId: null,
      })
      .execute()

    const revoked = await call(
      "POST",
      `/v1/orgs/${orgSlug}/oauth-grants/${grantId}/revoke`,
      owner!,
      { services: [{ id: serviceId, action: "keep" }] },
    )
    expect(revoked.status).toBe(200)
    expect((revoked.json.kept as Json[])[0]?.connectionUri).toBeUndefined()

    const live = await liveCredentials(serviceId)
    expect(live).toEqual([{ id: userCredentialId, oauthGrantId: null, revokedAt: null }])
  })

  it("refuses to revoke while a database is unaccounted for", async ({ skip }) => {
    if (!reachable) skip()
    const { grantId } = await grantWithDatabase()

    const refused = await call(
      "POST",
      `/v1/orgs/${orgSlug}/oauth-grants/${grantId}/revoke`,
      owner!,
      { services: [] },
    )
    expect(refused.status).toBe(400)

    // And the grant is still live, so the screen can be reloaded and retried.
    const still = await db
      .selectFrom("oauthGrant")
      .select("revokedAt")
      .where("id", "=", grantId)
      .executeTakeFirst()
    expect(still?.revokedAt).toBeNull()
  })

  /*
    Consent is personal, so another member of the same organization cannot see or revoke it — not
    even the owner. An organization that could revoke a member's grant could also silently rotate
    the credentials of databases that member depends on.
  */
  it("does not show one member's grants to another", async ({ skip }) => {
    if (!reachable) skip()
    const { grantId } = await grantWithDatabase()

    const other = await createTestUser("grants-other")
    await db
      .insertInto("organizationMember")
      .values({ id: v7(), organizationId, userId: other.id, status: "active" })
      .execute()

    const listed = await call("GET", `/v1/orgs/${orgSlug}/oauth-grants`, other)
    expect(listed.status).toBe(200)
    expect((listed.json.data as Json[]).map((g) => g.id)).not.toContain(grantId)

    const refused = await call(
      "POST",
      `/v1/orgs/${orgSlug}/oauth-grants/${grantId}/revoke`,
      other,
      { services: [] },
    )
    expect(refused.status).toBe(404)
  })
})
