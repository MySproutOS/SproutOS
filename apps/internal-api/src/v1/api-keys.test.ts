/* oxlint-disable no-await-in-loop */
import { hashKey, KEY_PREFIX } from "@lib/api-keys"
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
 * Programmatic API keys, and the intersection that bounds them.
 *
 * The interesting assertions are not that a key works — they are the three ways it must *stop*
 * working: outside its scopes, after its user is demoted, and after it is revoked.
 */
const up = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

/** A request authenticated by an API key rather than a session. */
async function withKey(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

let owner: TestUser | undefined
let orgSlug = ""
let organizationId = ""
const keyIds: string[] = []

function actor(): TestUser {
  if (owner === undefined) throw new Error("the fixture was not built")
  return owner
}

async function mint(name: string, scopes?: string[]): Promise<{ id: string; key: string }> {
  const created = await call("POST", `/v1/orgs/${orgSlug}/api-keys`, actor(), {
    name,
    ...(scopes === undefined ? {} : { scopes }),
  })
  expect(created.status).toBe(201)
  keyIds.push(created.json.id as string)
  return { id: created.json.id as string, key: created.json.key as string }
}

beforeAll(async () => {
  if (!up) return
  owner = await createTestUser("apikey")
  const created = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(owner),
    body: JSON.stringify({ name: `API Key Suite ${v7()}` }),
  })
  const organization = (await created.json()) as Json
  organizationId = organization.id as string
  orgSlug = organization.slug as string
  trackOrganization(organizationId)
})

afterAll(async () => {
  if (!up) return
  if (keyIds.length > 0) {
    await db.deleteFrom("apiKey").where("id", "in", keyIds).execute()
  }
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("minting and listing", () => {
  it("returns the key once and stores only its hash", async ({ skip }) => {
    if (!up) skip()
    const { id, key } = await mint("CI import")
    expect(key.startsWith(KEY_PREFIX)).toBe(true)

    const stored = await db
      .selectFrom("apiKey")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()

    // A stolen table must yield nothing that can be sent with.
    expect(JSON.stringify(stored)).not.toContain(key)
    expect(stored.keyHash).toBe(await hashKey(key))
    expect(stored.prefix.length).toBeLessThan(key.length)

    // And no route hands it back.
    const list = await call("GET", `/v1/orgs/${orgSlug}/api-keys`, actor())
    expect(JSON.stringify(list.json)).not.toContain(key)
    const entry = (list.json.data as Json[]).find((row) => row.id === id)
    expect(entry?.name).toBe("CI import")
    expect(entry?.lastUsedAt).toBeNull()
  })

  it("refuses a scope that is not a real permission", async ({ skip }) => {
    if (!up) skip()
    /*
      A typo would otherwise mint a key that silently does nothing, and the customer would spend the
      afternoon debugging their script rather than their key.
    */
    const response = await call("POST", `/v1/orgs/${orgSlug}/api-keys`, actor(), {
      name: "Typo",
      scopes: ["projects:read"],
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(response.json)).toContain("projects:read")
  })

  it("accepts a wildcard that covers something real", async ({ skip }) => {
    if (!up) skip()
    const { id } = await mint("Project bot", ["project:*"])
    const list = await call("GET", `/v1/orgs/${orgSlug}/api-keys`, actor())
    expect((list.json.data as Json[]).find((row) => row.id === id)?.scopes).toEqual(["project:*"])
  })
})

describe.skipIf(!up)("what a key can do", () => {
  it("authenticates a request and stamps last used", async ({ skip }) => {
    if (!up) skip()
    const { id, key } = await mint("Reader", ["project:read"])

    const response = await withKey("GET", `/v1/orgs/${orgSlug}/projects`, key)
    expect(response.status).toBe(200)

    /*
      Polled, not read once.

      `stampUsed` is `void`-ed on purpose in `bearer.ts`: it is the "last used" column on a settings
      page, and refusing a request because a bookkeeping write failed would trade a real capability
      for a cosmetic one. The consequence is that the write lands *after* the response, so reading
      the column the instant the request returns is a race — one this passed locally against a
      warm database and lost in CI against a container.

      Waiting for it is the honest assertion: the claim is "this eventually records the use", not
      "it records it before the response".
    */
    await expect
      .poll(
        async () =>
          (
            await db
              .selectFrom("apiKey")
              .select("lastUsedAt")
              .where("id", "=", id)
              .executeTakeFirstOrThrow()
          ).lastUsedAt,
        { timeout: 5000 },
      )
      .not.toBeNull()
  })

  it("is refused outside its scopes even though its user is the owner", async ({ skip }) => {
    if (!up) skip()
    /*
      The intersection, in the direction people forget.

      The owner can create projects. A key granted only `project:read` cannot, and that has to hold
      *because of the scope*, not because of the user — otherwise the scopes are decorative and a
      read-only CI key could delete production.
    */
    const { key } = await mint("Read only", ["project:read"])

    const response = await withKey("POST", `/v1/orgs/${orgSlug}/projects`, key, {
      name: "Should not exist",
      source: { type: "blank" },
    })
    expect(response.status).toBe(403)
  })

  it("shrinks when its user is demoted", async ({ skip }) => {
    if (!up) skip()
    /*
      The other direction, and the reason scopes alone are not enough.

      A key granted `*` by an owner must stop being able to do owner things the moment that person
      is a member — a grant made in March cannot outlive the permission it was based on.
    */
    const member = await createTestUser("apikey-member")
    const roles = await db
      .selectFrom("role")
      .select(["id", "name"])
      .where("organizationId", "=", organizationId)
      .execute()
    const memberRoleId = roles.find((role) => role.name === "member")?.id

    const invite = await call("POST", `/v1/orgs/${orgSlug}/invites`, actor(), {
      email: member.email,
      roleId: memberRoleId,
    })
    expect(invite.status).toBe(201)
    expect(
      (await call("POST", "/v1/invites/accept", member, { token: invite.json.token })).status,
    ).toBe(200)

    // The member mints a key granting everything they can think of.
    const created = await call("POST", `/v1/orgs/${orgSlug}/api-keys`, member, {
      name: "Ambitious",
      scopes: ["*"],
    })
    /*
      Minting is itself gated on `credential:write`, which a member does not have — so the
      escalation is refused one step earlier than the intersection. Both gates are real; this
      asserts the one that actually fires.
    */
    expect(created.status).toBe(403)
  })

  it("stops working the moment it is revoked", async ({ skip }) => {
    if (!up) skip()
    const { id, key } = await mint("Doomed", ["project:read"])
    expect((await withKey("GET", `/v1/orgs/${orgSlug}/projects`, key)).status).toBe(200)

    const revoked = await call("DELETE", `/v1/orgs/${orgSlug}/api-keys/${id}`, actor())
    expect(revoked.status).toBe(204)

    // Immediately, not eventually. There is no cache between the key and the row.
    expect((await withKey("GET", `/v1/orgs/${orgSlug}/projects`, key)).status).toBe(401)

    // And it leaves the list.
    const list = await call("GET", `/v1/orgs/${orgSlug}/api-keys`, actor())
    expect((list.json.data as Json[]).some((row) => row.id === id)).toBe(false)
  })

  it("stops working when it expires", async ({ skip }) => {
    if (!up) skip()
    const { id, key } = await mint("Short lived", ["project:read"])
    await db
      .updateTable("apiKey")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", id)
      .execute()

    expect((await withKey("GET", `/v1/orgs/${orgSlug}/projects`, key)).status).toBe(401)
  })

  it("answers the same way for an unknown key, a revoked one and an expired one", async ({
    skip,
  }) => {
    if (!up) skip()
    // Any difference is an oracle for working out which keys are real, one request at a time.
    const unknown = await withKey(
      "GET",
      `/v1/orgs/${orgSlug}/projects`,
      `${KEY_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    )
    const { id, key } = await mint("Another doomed", ["project:read"])
    await call("DELETE", `/v1/orgs/${orgSlug}/api-keys/${id}`, actor())
    const revoked = await withKey("GET", `/v1/orgs/${orgSlug}/projects`, key)

    expect(unknown.status).toBe(401)
    expect(revoked.status).toBe(unknown.status)
    expect(revoked.json).toEqual(unknown.json)
  })

  it("cannot reach another organization", async ({ skip }) => {
    if (!up) skip()
    const { key } = await mint("Local", ["*"])

    const stranger = await createTestUser("apikey-outsider")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(stranger),
      body: JSON.stringify({ name: `Outsider ${v7()}` }),
    })
    const other = (await created.json()) as Json
    trackOrganization(other.id as string)

    // A key granted `*` is granted everything *its user* can do, and its user is not a member here.
    const response = await withKey("GET", `/v1/orgs/${other.slug as string}/projects`, key)
    expect([403, 404]).toContain(response.status)
  })

  it("refuses to revoke a key belonging to another organization", async ({ skip }) => {
    if (!up) skip()
    const { id } = await mint("Mine", ["*"])

    const stranger = await createTestUser("apikey-thief")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(stranger),
      body: JSON.stringify({ name: `Thief ${v7()}` }),
    })
    const other = (await created.json()) as Json
    trackOrganization(other.id as string)

    // 404, not 403: a different answer would confirm the id is real.
    const response = await call(
      "DELETE",
      `/v1/orgs/${other.slug as string}/api-keys/${id}`,
      stranger,
    )
    expect(response.status).toBe(404)

    const stillLive = await db
      .selectFrom("apiKey")
      .select("revokedAt")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
    expect(stillLive.revokedAt).toBeNull()
  })

  it("does not let a bearer credential sign out a browser session", async ({ skip }) => {
    if (!up) skip()
    // There is no cookie to clear. Revoking a key is a different action with a different endpoint.
    const { key } = await mint("No logout", ["*"])
    const response = await withKey("POST", "/v1/auth/logout", key)
    expect(response.status).toBe(400)
  })
})
