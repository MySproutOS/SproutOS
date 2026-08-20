/* oxlint-disable no-await-in-loop */
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
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
 * Closing an account.
 *
 * A `delete from "user"` cannot work — `audit_log.actor_user_id`, `api_key.user_id` and
 * `organization.owner_user_id` are all `ON DELETE RESTRICT`, so it fails for anyone who has ever
 * done anything. What is tested here is what closing an account has to mean instead: the person is
 * gone from the product, and nothing they held still authenticates.
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

const closed: string[] = []

async function person(label: string): Promise<TestUser> {
  const user = await createTestUser(label)
  closed.push(user.id)
  return user
}

afterAll(async () => {
  if (!up) return
  // A closed account is soft-deleted, so the shared teardown's delete would be refused by the same
  // RESTRICTs this suite is about. Clear what points at them first.
  if (closed.length > 0) {
    await db.deleteFrom("apiKey").where("userId", "in", closed).execute()
  }
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("closing an account", () => {
  it("refuses while the person still owns an organization, and names it", async ({ skip }) => {
    if (!up) skip()
    /*
      Someone has to be responsible for a team's data and its bill. Orphaning it or cascading the
      delete are both worse than saying so — and a message that does not say *which* team leaves
      the person to guess.
    */
    const user = await person("close-owner")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: `Owned ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    trackOrganization(organization.id as string)

    const response = await call("DELETE", "/v1/user/me/delete", user)
    expect(response.status).toBe(409)
    expect(JSON.stringify(response.json)).toContain(organization.slug as string)

    // And the account is untouched — a refusal must not half-close it.
    const row = await db
      .selectFrom("user")
      .select(["deletedAt", "email"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow()
    expect(row.deletedAt).toBeNull()
    expect(row.email).toBe(user.email)
  })

  it("closes an account that owns nothing", async ({ skip }) => {
    if (!up) skip()
    const user = await person("close-plain")
    const response = await call("DELETE", "/v1/user/me/delete", user)
    expect(response.status).toBe(200)

    const row = await db
      .selectFrom("user")
      .selectAll()
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow()

    expect(row.deletedAt).not.toBeNull()
    // The personal data is what makes a row a person; the id `audit_log` points at is not.
    expect(row.name).toBeNull()
    expect(row.image).toBeNull()
    expect(row.email).not.toBe(user.email)
    /*
      `.invalid` is reserved by RFC 2606 precisely so it can never route — a tombstone that cannot
      be mistaken for a live address and cannot collide with a real one. Null is not an option:
      `user.email` is NOT NULL and unique.
    */
    expect(row.email.endsWith("@invalid")).toBe(true)
  })

  it("forgets the GitHub identity, so signing in again is a new account", async ({ skip }) => {
    if (!up) skip()
    const user = await person("close-github")
    await db
      .updateTable("user")
      .set({ githubUserId: BigInt(Date.now()), githubLogin: "someone" })
      .where("id", "=", user.id)
      .execute()

    await call("DELETE", "/v1/user/me/delete", user)

    const row = await db
      .selectFrom("user")
      .select(["githubUserId", "githubLogin"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow()
    // Keeping it would have the next sign-in resurrect the closed account rather than create one.
    expect(row.githubUserId).toBeNull()
    expect(row.githubLogin).toBeNull()
  })

  it("ends the session immediately", async ({ skip }) => {
    if (!up) skip()
    const user = await person("close-session")
    expect((await call("GET", "/v1/user/me/profile", user)).status).toBe(200)

    await call("DELETE", "/v1/user/me/delete", user)

    // No window where the account is closed and the cookie still works.
    const after = await call("GET", "/v1/user/me/profile", user)
    expect(after.status).toBe(401)
  })

  it("revokes the API keys they held", async ({ skip }) => {
    if (!up) skip()
    /*
      The sharpest case. An API key outlives a browser session by design — it is meant to sit in
      CI for a year — so an account closed without revoking its keys is an account that is still
      making requests.
    */
    const user = await person("close-keys")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: `Keys ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    const orgId = organization.id as string
    trackOrganization(orgId)

    const minted = await call("POST", `/v1/orgs/${organization.slug as string}/api-keys`, user, {
      name: "CI",
      scopes: ["project:read"],
    })
    expect(minted.status).toBe(201)
    const key = minted.json.key as string

    const works = await app.request(`/v1/orgs/${organization.slug as string}/projects`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    expect(works.status).toBe(200)

    // Hand the organization on, so the close is not refused for ownership.
    const heir = await person("close-keys-heir")
    await db
      .updateTable("organization")
      .set({ ownerUserId: heir.id })
      .where("id", "=", orgId)
      .execute()

    expect((await call("DELETE", "/v1/user/me/delete", user)).status).toBe(200)

    const after = await app.request(`/v1/orgs/${organization.slug as string}/projects`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    expect(after.status).toBe(401)

    /*
      Asserted on the row as well as on the request.

      Two things stop this key independently: it is revoked, and the bearer path refuses to load a
      soft-deleted user. The HTTP check alone passes on either, so removing the revocation would
      leave a live `api_key` row that only the second guard catches — and a guard nobody is testing
      is a guard someone will simplify away.
    */
    const stored = await db
      .selectFrom("apiKey")
      .select("revokedAt")
      .where("id", "=", minted.json.id as string)
      .executeTakeFirstOrThrow()
    expect(stored.revokedAt).not.toBeNull()
  })

  it("leaves the teams they were a member of", async ({ skip }) => {
    if (!up) skip()
    // A closed account must not still appear in someone else's member list.
    const owner = await person("close-team-owner")
    const member = await person("close-team-member")

    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ name: `Team ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    trackOrganization(organization.id as string)

    const roles = await db
      .selectFrom("role")
      .select(["id", "name"])
      .where("organizationId", "=", organization.id as string)
      .execute()
    const invite = await call("POST", `/v1/orgs/${organization.slug as string}/invites`, owner, {
      email: member.email,
      roleId: roles.find((role) => role.name === "member")?.id,
    })
    expect(invite.status).toBe(201)
    expect(
      (await call("POST", "/v1/invites/accept", member, { token: invite.json.token })).status,
    ).toBe(200)

    expect((await call("DELETE", "/v1/user/me/delete", member)).status).toBe(200)

    const members = await call("GET", `/v1/orgs/${organization.slug as string}/members`, owner)
    const ids = (members.json.data as Json[]).map((row) => row.userId ?? row.id)
    expect(ids).not.toContain(member.id)
  })

  it("keeps the audit trail readable", async ({ skip }) => {
    if (!up) skip()
    /*
      The reason this is a soft delete at all. `audit_log.actor_user_id` is RESTRICT because a trail
      that loses its actor cannot answer the question it exists for.
    */
    const user = await person("close-audit")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(user),
      body: JSON.stringify({ name: `Audited ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    const orgId = organization.id as string
    trackOrganization(orgId)

    const heir = await person("close-audit-heir")
    await db
      .updateTable("organization")
      .set({ ownerUserId: heir.id })
      .where("id", "=", orgId)
      .execute()

    const before = await db
      .selectFrom("auditLog")
      .select("id")
      .where("actorUserId", "=", user.id)
      .execute()

    expect((await call("DELETE", "/v1/user/me/delete", user)).status).toBe(200)

    const after = await db
      .selectFrom("auditLog")
      .select("id")
      .where("actorUserId", "=", user.id)
      .execute()
    expect(after.length).toBe(before.length)
  })
})
