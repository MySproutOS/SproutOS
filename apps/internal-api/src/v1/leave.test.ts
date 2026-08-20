// Fixtures are built in order; each step reads the row the previous one wrote.
/* oxlint-disable no-await-in-loop */
import { fetchUserPreference, provisionOrganization } from "@lib/dao"
import { db } from "@sproutos/db"
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

const reachable = await databaseReachable()

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

/** Puts `user` into `slug` as a plain member, via a real invite round trip. */
async function joinAsMember(owner: TestUser, slug: string, user: TestUser): Promise<void> {
  const roles = (await call("GET", `/v1/orgs/${slug}/roles`, owner)).json.data as {
    id: string
    name: string
  }[]
  const memberRoleId = roles.find((role) => role.name === "member")?.id

  const invited = await call("POST", `/v1/orgs/${slug}/invites`, owner, {
    email: user.email,
    roleId: memberRoleId,
  })
  if (invited.status !== 201) {
    throw new Error(`fixture setup failed: invite returned ${invited.status}`)
  }

  const accepted = await call("POST", "/v1/invites/accept", user, {
    token: invited.json.token as string,
  })
  if (accepted.status !== 200) {
    throw new Error(`fixture setup failed: accept returned ${accepted.status}`)
  }
}

describe.skipIf(!reachable)("leaving an organization", () => {
  let owner: TestUser
  let member: TestUser
  let stranger: TestUser
  let slug: string
  let organizationId: string

  beforeAll(async () => {
    owner = await createTestUser("leaveowner")
    member = await createTestUser("leavemember")
    stranger = await createTestUser("leavestranger")

    const created = await call("POST", "/v1/orgs", owner, { name: "Leave Suite" })
    if (created.status !== 201) {
      throw new Error(`fixture setup failed: POST /v1/orgs returned ${created.status}`)
    }
    organizationId = trackOrganization(created.json.id as string)
    slug = created.json.slug as string

    await joinAsMember(owner, slug, member)
  })

  afterAll(async () => {
    await cleanupFixtures()
  })

  it("hides the route from a non-member exactly like every other org route", async () => {
    const response = await call("DELETE", `/v1/orgs/${slug}/leave`, stranger)
    expect(response.status).toBe(404)
  })

  /** The owner is `ON DELETE RESTRICT` against their own membership, and 403 would be a lie. */
  it("refuses the owner with a 409 naming both ways out", async () => {
    const response = await call("DELETE", `/v1/orgs/${slug}/leave`, owner)
    expect(response.status).toBe(409)

    const error = response.json.error as { code: string; message: string }
    expect(error.code).toBe("Conflict")
    expect(error.message).toContain("Transfer ownership")
  })

  it("refuses a personal organization, which has nowhere to fall back to", async () => {
    const solo = await createTestUser("leavesolo")
    const personal = await provisionOrganization(db).ensureDefaultOrganization({
      userId: solo.id,
      name: "Solo Person",
      email: solo.email,
    })
    trackOrganization(personal.id)
    expect(personal.kind).toBe("personal")

    const response = await call("DELETE", `/v1/orgs/${personal.slug}/leave`, solo)
    expect(response.status).toBe(409)
    expect((response.json.error as { message: string }).message).toContain("personal team")
  })

  it("lets a plain member leave without any permission for it", async () => {
    // The member role grants no `member:remove`, so this succeeding is the point.
    const response = await call("DELETE", `/v1/orgs/${slug}/leave`, member)
    expect(response.status).toBe(200)
  })

  it("removes the membership and every permission row it carried", async () => {
    const membership = await db
      .selectFrom("organizationMember")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("userId", "=", member.id)
      .executeTakeFirst()
    expect(membership).toBeUndefined()

    const permissions = await db
      .selectFrom("memberPermission")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("userId", "=", member.id)
      .execute()
    expect(permissions).toStrictEqual([])
  })

  it("makes the organization unreachable to them afterwards", async () => {
    expect((await call("GET", `/v1/orgs/${slug}`, member)).status).toBe(404)
    expect((await call("DELETE", `/v1/orgs/${slug}/leave`, member)).status).toBe(404)
  })

  it("drops them from the member list the owner sees", async () => {
    const members = (await call("GET", `/v1/orgs/${slug}/members`, owner)).json.data as {
      userId: string
    }[]
    expect(members.map((row) => row.userId)).not.toContain(member.id)
  })

  it("audits the departure with the leaver as the actor", async () => {
    const audit = await db
      .selectFrom("auditLog")
      .select(["actorUserId", "action", "after"])
      .where("organizationId", "=", organizationId)
      .where("action", "=", "member:leave")
      .executeTakeFirstOrThrow()

    expect(audit.actorUserId).toBe(member.id)
    expect(audit.after).toBeNull()
  })
})

describe.skipIf(!reachable)("last_org_id after leaving", () => {
  afterAll(async () => {
    await cleanupFixtures()
  })

  it("repoints at the personal organization rather than being left dangling", async () => {
    const owner = await createTestUser("repointowner")
    const leaver = await createTestUser("repointleaver")

    const personal = await provisionOrganization(db).ensureDefaultOrganization({
      userId: leaver.id,
      name: "Repoint Leaver",
      email: leaver.email,
    })
    trackOrganization(personal.id)

    const created = await call("POST", "/v1/orgs", owner, { name: "Repoint Team" })
    const teamSlug = created.json.slug as string
    trackOrganization(created.json.id as string)

    await joinAsMember(owner, teamSlug, leaver)

    // Accepting an invite makes the new team their last organization.
    expect(await fetchUserPreference(db).getLastOrganizationId(leaver.id)).toBe(
      created.json.id as string,
    )

    const left = await call("DELETE", `/v1/orgs/${teamSlug}/leave`, leaver)
    expect(left.status).toBe(200)
    expect(left.json.nextOrganizationId).toBe(personal.id)

    expect(await fetchUserPreference(db).getLastOrganizationId(leaver.id)).toBe(personal.id)
  })

  it("leaves a pointer at an unrelated organization alone", async () => {
    const owner = await createTestUser("untouchedowner")
    const leaver = await createTestUser("untouchedleaver")

    const personal = await provisionOrganization(db).ensureDefaultOrganization({
      userId: leaver.id,
      name: "Untouched Leaver",
      email: leaver.email,
    })
    trackOrganization(personal.id)

    const created = await call("POST", "/v1/orgs", owner, { name: "Untouched Team" })
    const teamSlug = created.json.slug as string
    trackOrganization(created.json.id as string)

    await joinAsMember(owner, teamSlug, leaver)

    // Point them back at their personal org, so the team they leave is not the current one.
    await db
      .updateTable("userPreference")
      .set({ lastOrgId: personal.id })
      .where("userId", "=", leaver.id)
      .execute()

    const left = await call("DELETE", `/v1/orgs/${teamSlug}/leave`, leaver)
    expect(left.status).toBe(200)
    expect(left.json.nextOrganizationId).toBe(personal.id)
    expect(await fetchUserPreference(db).getLastOrganizationId(leaver.id)).toBe(personal.id)
  })

  it("reports no next organization when the only team is gone", async () => {
    const owner = await createTestUser("orphanowner")
    const orphan = await createTestUser("orphanleaver")

    const created = await call("POST", "/v1/orgs", owner, { name: "Orphan Team" })
    const teamSlug = created.json.slug as string
    trackOrganization(created.json.id as string)

    await joinAsMember(owner, teamSlug, orphan)

    const left = await call("DELETE", `/v1/orgs/${teamSlug}/leave`, orphan)
    expect(left.status).toBe(200)
    expect(left.json.nextOrganizationId).toBeNull()
    expect(await fetchUserPreference(db).getLastOrganizationId(orphan.id)).toBeNull()
  })
})

describe.skipIf(!reachable)("GET /v1/user/me/preferences", () => {
  afterAll(async () => {
    await cleanupFixtures()
  })

  it("returns the organization the user was last in, as a slug", async () => {
    const user = await createTestUser("prefslast")
    const personal = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Prefs Last",
      email: user.email,
    })
    trackOrganization(personal.id)

    const second = await provisionOrganization(db).createOrganization({
      userId: user.id,
      name: "Prefs Second Team",
    })
    trackOrganization(second.id)

    // createOrganization points last_org_id at the new team.
    const response = await call("GET", "/v1/user/me/preferences", user)
    expect(response.status).toBe(200)
    expect(response.json.lastOrganizationId).toBe(second.id)
    expect(response.json.lastOrganizationSlug).toBe(second.slug)
  })

  /** The bug this endpoint exists to fix: three teams, and the redirect picked an arbitrary one. */
  it("falls back to the personal organization when the pointer is stale", async () => {
    const user = await createTestUser("prefsstale")
    const personal = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Prefs Stale",
      email: user.email,
    })
    trackOrganization(personal.id)

    for (const name of ["Prefs Extra A", "Prefs Extra B"]) {
      const extra = await provisionOrganization(db).createOrganization({ userId: user.id, name })
      trackOrganization(extra.id)
    }

    await db
      .updateTable("userPreference")
      .set({ lastOrgId: null })
      .where("userId", "=", user.id)
      .execute()

    const response = await call("GET", "/v1/user/me/preferences", user)
    expect(response.status).toBe(200)
    expect(response.json.lastOrganizationId).toBe(personal.id)
    expect(response.json.lastOrganizationSlug).toBe(personal.slug)
  })

  it("returns nulls rather than failing for a user who belongs to nothing", async () => {
    const user = await createTestUser("prefsnone")

    const response = await call("GET", "/v1/user/me/preferences", user)
    expect(response.status).toBe(200)
    expect(response.json.lastOrganizationId).toBeNull()
    expect(response.json.lastOrganizationSlug).toBeNull()
    expect(response.json.sidebarCollapsed).toBe(false)
    expect(response.json.navPinnedProjectIds).toStrictEqual([])
  })
})
