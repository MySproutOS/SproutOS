/* oxlint-disable no-await-in-loop */
import { srnFor } from "@lib/srn"
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

function errorCode(json: Json): string | undefined {
  const error = json.error as { code?: string } | undefined
  return error?.code
}

describe.skipIf(!reachable)("organization, member, and role routes", () => {
  let owner: TestUser
  let invitee: TestUser
  let stranger: TestUser
  let slug: string
  let organizationId: string

  beforeAll(async () => {
    owner = await createTestUser("routeowner")
    invitee = await createTestUser("routeinvitee")
    stranger = await createTestUser("routestranger")

    const created = await call("POST", "/v1/orgs", owner, { name: "Route Suite" })
    if (created.status !== 201) {
      throw new Error(`fixture setup failed: POST /v1/orgs returned ${created.status}`)
    }
    organizationId = trackOrganization(created.json.id as string)
    slug = created.json.slug as string
  })

  afterAll(async () => {
    await cleanupFixtures()
  })

  it("creates an organization with the caller as owner and a slug derived from the name", () => {
    expect(slug).toBe("route-suite")
  })

  it("lists the organizations the caller belongs to", async () => {
    const response = await call("GET", "/v1/orgs", owner)
    expect(response.status).toBe(200)

    const data = response.json.data as { id: string }[]
    expect(data.map((row) => row.id)).toContain(organizationId)
    expect(response.json.nextCursor).toBeNull()
  })

  it("does not list another user's organization", async () => {
    const response = await call("GET", "/v1/orgs", stranger)
    expect(response.status).toBe(200)
    expect(response.json.data).toStrictEqual([])
  })

  it("reads the organization for a member", async () => {
    const response = await call("GET", `/v1/orgs/${slug}`, owner)
    expect(response.status).toBe(200)
    expect(response.json.name).toBe("Route Suite")
    expect(response.json.ownerUserId).toBe(owner.id)
  })

  /**
   * 404 rather than 403 for a non-member. A 403 would confirm the slug names a real team, which is
   * information a stranger should not be able to enumerate.
   */
  it("hides the organization's existence from a non-member", async () => {
    const response = await call("GET", `/v1/orgs/${slug}`, stranger)
    expect(response.status).toBe(404)
  })

  it("hides an organization that does not exist at all, identically", async () => {
    const response = await call("GET", "/v1/orgs/no-such-team", stranger)
    expect(response.status).toBe(404)
  })

  it("rejects a reserved slug", async () => {
    const response = await call("PATCH", `/v1/orgs/${slug}`, owner, { slug: "settings" })
    expect(response.status).toBe(400)
    expect(errorCode(response.json)).toBe("ValidationFailed")
  })

  it("renames the organization and audits the change", async () => {
    const response = await call("PATCH", `/v1/orgs/${slug}`, owner, { name: "Route Suite Renamed" })
    expect(response.status).toBe(200)
    expect(response.json.name).toBe("Route Suite Renamed")

    const audit = await db
      .selectFrom("auditLog")
      .select(["action", "resourceSrn"])
      .where("organizationId", "=", organizationId)
      .where("action", "=", "org:update")
      .executeTakeFirst()

    expect(audit?.resourceSrn).toBe(srnFor("org", organizationId, "organization", organizationId))
  })

  describe("the organization list", () => {
    it("names the caller's own roles, not every member's", async () => {
      const list = await call("GET", "/v1/orgs", owner)
      expect(list.status).toBe(200)

      const rows = list.json.data as { id: string; ownerUserId: string; roleNames: string[] }[]
      const row = rows.find((entry) => entry.id === organizationId)

      expect(row?.ownerUserId).toBe(owner.id)
      expect(row?.roleNames).toContain("owner")
    })

    it("labels an admin as an admin rather than as a member", async () => {
      /*
        The defect this exists for.

        Without `roleNames` the only thing a client could derive was `ownerUserId === me.id`, so
        every non-owner — including an organization admin — read as "Member" in the team switcher.
        A sidebar cannot fix that by fetching `.../members` per organization: that is a request per
        team on every page load.

        Its own organization, not the suite's. Adding a third member to the shared fixture broke a
        later test that counts them — shared mutable fixtures are how a passing suite starts
        depending on the order it runs in.
      */
      const created = await call("POST", "/v1/orgs", owner, { name: "Admin Label Suite" })
      expect(created.status).toBe(201)
      const labelOrgId = trackOrganization(created.json.id as string)
      const labelSlug = created.json.slug as string

      const roles = (await call("GET", `/v1/orgs/${labelSlug}/roles`, owner)).json.data as {
        id: string
        name: string
      }[]
      const adminRoleId = roles.find((role) => role.name === "admin")?.id ?? ""
      expect(adminRoleId).not.toBe("")

      const admin = await createTestUser("routeadmin")
      const invite = await call("POST", `/v1/orgs/${labelSlug}/invites`, owner, {
        email: admin.email,
        roleId: adminRoleId,
      })
      expect(invite.status).toBe(201)
      const accepted = await call("POST", "/v1/invites/accept", admin, {
        token: invite.json.token as string,
      })
      expect(accepted.status).toBe(200)

      const rows = (await call("GET", "/v1/orgs", admin)).json.data as {
        id: string
        ownerUserId: string
        roleNames: string[]
      }[]
      const row = rows.find((entry) => entry.id === labelOrgId)

      expect(row?.roleNames).toStrictEqual(["admin"])
      // And they are still not the owner, so a client can tell the two apart.
      expect(row?.ownerUserId).not.toBe(admin.id)

      // The owner's view of the same organization is their own row, not the admin's.
      const ownerRows = (await call("GET", "/v1/orgs", owner)).json.data as {
        id: string
        roleNames: string[]
      }[]
      expect(ownerRows.find((entry) => entry.id === labelOrgId)?.roleNames).toStrictEqual(["owner"])
    })
  })

  describe("invites", () => {
    let memberRoleId: string
    let token: string

    it("exposes the three system roles", async () => {
      const response = await call("GET", `/v1/orgs/${slug}/roles`, owner)
      expect(response.status).toBe(200)

      const roles = response.json.data as { id: string; name: string; isSystem: boolean }[]
      expect(roles.map((role) => role.name).sort()).toStrictEqual(["admin", "member", "owner"])
      expect(roles.every((role) => role.isSystem)).toBe(true)

      memberRoleId = roles.find((role) => role.name === "member")?.id ?? ""
      expect(memberRoleId).not.toBe("")
    })

    it("refuses to invite anyone into the owner role", async () => {
      const roles = (await call("GET", `/v1/orgs/${slug}/roles`, owner)).json.data as {
        id: string
        name: string
      }[]
      const ownerRoleId = roles.find((role) => role.name === "owner")?.id

      const response = await call("POST", `/v1/orgs/${slug}/invites`, owner, {
        email: invitee.email,
        roleId: ownerRoleId,
      })
      expect(response.status).toBe(400)
    })

    it("issues an invite and returns the token exactly once", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/invites`, owner, {
        email: invitee.email,
        roleId: memberRoleId,
      })
      expect(response.status).toBe(201)

      token = response.json.token as string
      expect(token.length).toBeGreaterThan(20)

      const stored = await db
        .selectFrom("organizationInvite")
        .select(["tokenHash"])
        .where("id", "=", response.json.id as string)
        .executeTakeFirstOrThrow()

      expect(stored.tokenHash).not.toBe(token)
    })

    it("refuses a second pending invite to the same address", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/invites`, owner, {
        email: invitee.email,
        roleId: memberRoleId,
      })
      expect(response.status).toBe(400)
      expect(errorCode(response.json)).toBe("ResourceAlreadyExists")
    })

    it("refuses to redeem an invite issued to a different address", async () => {
      const response = await call("POST", "/v1/invites/accept", stranger, { token })
      expect(response.status).toBe(403)
    })

    it("redeems the invite for the address it names", async () => {
      const response = await call("POST", "/v1/invites/accept", invitee, { token })
      expect(response.status).toBe(200)
      expect(response.json.organizationId).toBe(organizationId)
    })

    it("refuses to redeem the same token twice", async () => {
      const response = await call("POST", "/v1/invites/accept", invitee, { token })
      expect(response.status).toBe(400)
    })

    it("lists both members with the roles they hold", async () => {
      const response = await call("GET", `/v1/orgs/${slug}/members`, owner)
      expect(response.status).toBe(200)

      const members = response.json.data as {
        userId: string
        isOwner: boolean
        roles: { name: string }[]
      }[]
      expect(members).toHaveLength(2)

      const ownerRow = members.find((row) => row.userId === owner.id)
      const inviteeRow = members.find((row) => row.userId === invitee.id)
      expect(ownerRow?.isOwner).toBe(true)
      expect(ownerRow?.roles.map((role) => role.name)).toStrictEqual(["owner"])
      expect(inviteeRow?.isOwner).toBe(false)
      expect(inviteeRow?.roles.map((role) => role.name)).toStrictEqual(["member"])
    })
  })

  describe("authorization at the route boundary", () => {
    it("lets the plain member read the organization", async () => {
      const response = await call("GET", `/v1/orgs/${slug}`, invitee)
      expect(response.status).toBe(200)
    })

    it("refuses the plain member the actions the member role does not grant", async () => {
      for (const [method, path] of [
        ["PATCH", `/v1/orgs/${slug}`],
        ["DELETE", `/v1/orgs/${slug}`],
      ] as const) {
        const response = await call(method, path, invitee, { name: "Hijacked" })
        expect([path, response.status, errorCode(response.json)]).toStrictEqual([
          path,
          403,
          "InsufficientPermissions",
        ])
      }
    })

    it("refuses the plain member the ability to invite", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/invites`, invitee, {
        email: "someone@rbac.test",
        roleId: "01912d41-0000-7000-8000-0000000000b1",
      })
      expect(response.status).toBe(403)
    })
  })

  describe("custom roles", () => {
    let customRoleId: string

    it("refuses an action that is not in the catalogue", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/roles`, owner, {
        name: "typo",
        statements: [
          {
            effect: "allow",
            actions: ["project:writ"],
            resources: [`srn:sproutos:*:${organizationId}:*`],
          },
        ],
      })
      expect(response.status).toBe(400)
      expect(errorCode(response.json)).toBe("ValidationFailed")
    })

    it("refuses a resource that is not an SRN", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/roles`, owner, {
        name: "bare-id",
        statements: [
          { effect: "allow", actions: ["project:read"], resources: [`project:${organizationId}`] },
        ],
      })
      expect(response.status).toBe(400)
    })

    /** A statement naming another tenant is refused at the edge, not merely made inert by the query. */
    it("refuses a resource scoped to another organization", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/roles`, owner, {
        name: "cross-tenant",
        statements: [
          {
            effect: "allow",
            actions: ["project:read"],
            resources: ["srn:sproutos:*:0191a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b:*"],
          },
        ],
      })
      expect(response.status).toBe(400)
    })

    it("refuses to shadow a system role name", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/roles`, owner, {
        name: "admin",
        statements: [
          {
            effect: "allow",
            actions: ["project:read"],
            resources: [`srn:sproutos:*:${organizationId}:*`],
          },
        ],
      })
      expect(response.status).toBe(400)
    })

    it("creates a custom role", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/roles`, owner, {
        name: "inviter",
        description: "May invite people and nothing else new",
        statements: [
          {
            effect: "allow",
            actions: ["member:invite", "member:read", "org:read"],
            resources: [`srn:sproutos:*:${organizationId}:*`],
          },
        ],
      })
      expect(response.status).toBe(201)
      customRoleId = response.json.id as string
    })

    it("refuses to edit a system role", async () => {
      const roles = (await call("GET", `/v1/orgs/${slug}/roles`, owner)).json.data as {
        id: string
        name: string
      }[]
      const adminRoleId = roles.find((role) => role.name === "admin")?.id

      const response = await call("PATCH", `/v1/orgs/${slug}/roles/${adminRoleId}`, owner, {
        name: "superadmin",
      })
      expect(response.status).toBe(400)
      expect(errorCode(response.json)).toBe("ResourceLocked")
    })

    it("grants the custom role and the permission takes effect immediately", async () => {
      const members = (await call("GET", `/v1/orgs/${slug}/members`, owner)).json.data as {
        id: string
        userId: string
        roles: { id: string }[]
      }[]
      const inviteeMember = members.find((row) => row.userId === invitee.id)
      const existingRoleIds = inviteeMember?.roles.map((role) => role.id) ?? []

      const assign = await call(
        "PUT",
        `/v1/orgs/${slug}/members/${inviteeMember?.id}/roles`,
        owner,
        { roleIds: [...existingRoleIds, customRoleId] },
      )
      expect(assign.status).toBe(200)

      const roles = (await call("GET", `/v1/orgs/${slug}/roles`, invitee)).json.data as {
        id: string
        name: string
      }[]
      const memberRoleId = roles.find((role) => role.name === "member")?.id

      const invited = await call("POST", `/v1/orgs/${slug}/invites`, invitee, {
        email: `late-${Date.now()}@rbac.test`,
        roleId: memberRoleId,
      })
      expect(invited.status).toBe(201)
    })

    it("refuses to grant the owner role by assignment", async () => {
      const members = (await call("GET", `/v1/orgs/${slug}/members`, owner)).json.data as {
        id: string
        userId: string
      }[]
      const roles = (await call("GET", `/v1/orgs/${slug}/roles`, owner)).json.data as {
        id: string
        name: string
      }[]

      const inviteeMemberId = members.find((row) => row.userId === invitee.id)?.id
      const ownerRoleId = roles.find((role) => role.name === "owner")?.id

      const response = await call(
        "PUT",
        `/v1/orgs/${slug}/members/${inviteeMemberId}/roles`,
        owner,
        { roleIds: [ownerRoleId] },
      )
      expect(response.status).toBe(400)
    })

    it("refuses to delete a role somebody still holds", async () => {
      const response = await call("DELETE", `/v1/orgs/${slug}/roles/${customRoleId}`, owner)
      expect(response.status).toBe(409)
    })

    it("revokes the permission when the role is taken away", async () => {
      const members = (await call("GET", `/v1/orgs/${slug}/members`, owner)).json.data as {
        id: string
        userId: string
      }[]
      const roles = (await call("GET", `/v1/orgs/${slug}/roles`, owner)).json.data as {
        id: string
        name: string
      }[]

      const inviteeMemberId = members.find((row) => row.userId === invitee.id)?.id
      const memberRoleId = roles.find((role) => role.name === "member")?.id

      const revoke = await call("PUT", `/v1/orgs/${slug}/members/${inviteeMemberId}/roles`, owner, {
        roleIds: [memberRoleId],
      })
      expect(revoke.status).toBe(200)

      const invited = await call("POST", `/v1/orgs/${slug}/invites`, invitee, {
        email: `denied-${Date.now()}@rbac.test`,
        roleId: memberRoleId,
      })
      expect(invited.status).toBe(403)

      const deleted = await call("DELETE", `/v1/orgs/${slug}/roles/${customRoleId}`, owner)
      expect(deleted.status).toBe(200)
    })
  })

  describe("ownership transfer", () => {
    it("refuses to hand the organization to someone who is not a member", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/transfer-ownership`, owner, {
        newOwnerUserId: stranger.id,
      })
      expect(response.status).toBe(400)
    })

    it("refuses to remove the owner", async () => {
      const members = (await call("GET", `/v1/orgs/${slug}/members`, owner)).json.data as {
        id: string
        userId: string
      }[]
      const ownerMemberId = members.find((row) => row.userId === owner.id)?.id

      const response = await call("DELETE", `/v1/orgs/${slug}/members/${ownerMemberId}`, owner)
      expect(response.status).toBe(400)
    })

    it("moves ownership, swapping the owner and admin roles", async () => {
      const response = await call("POST", `/v1/orgs/${slug}/transfer-ownership`, owner, {
        newOwnerUserId: invitee.id,
      })
      expect(response.status).toBe(200)

      const members = (await call("GET", `/v1/orgs/${slug}/members`, invitee)).json.data as {
        userId: string
        isOwner: boolean
        roles: { name: string }[]
      }[]

      const newOwner = members.find((row) => row.userId === invitee.id)
      const formerOwner = members.find((row) => row.userId === owner.id)

      expect(newOwner?.isOwner).toBe(true)
      const newOwnerRoles = (newOwner?.roles ?? []).map((role) => role.name)
      expect([...newOwnerRoles].sort()).toStrictEqual(["member", "owner"])
      expect(formerOwner?.isOwner).toBe(false)
      expect(formerOwner?.roles.map((role) => role.name)).toStrictEqual(["admin"])
    })

    it("leaves the former owner able to administer but not to delete or transfer", async () => {
      const renamed = await call("PATCH", `/v1/orgs/${slug}`, owner, { name: "Still Editable" })
      expect(renamed.status).toBe(200)

      const deleted = await call("DELETE", `/v1/orgs/${slug}`, owner)
      expect(deleted.status).toBe(403)

      const transferred = await call("POST", `/v1/orgs/${slug}/transfer-ownership`, owner, {
        newOwnerUserId: owner.id,
      })
      expect(transferred.status).toBe(403)
    })

    it("audits the transfer in the same transaction as the change", async () => {
      const audit = await db
        .selectFrom("auditLog")
        .select(["actorUserId", "before", "after"])
        .where("organizationId", "=", organizationId)
        .where("action", "=", "org:transfer_ownership")
        .executeTakeFirstOrThrow()

      expect(audit.actorUserId).toBe(owner.id)
      expect(audit.before).toStrictEqual({ ownerUserId: owner.id })
      expect(audit.after).toStrictEqual({ ownerUserId: invitee.id })
    })

    it("lets the new owner soft-delete the organization, which then reads as gone", async () => {
      const deleted = await call("DELETE", `/v1/orgs/${slug}`, invitee)
      expect(deleted.status).toBe(200)

      const read = await call("GET", `/v1/orgs/${slug}`, invitee)
      expect(read.status).toBe(404)

      const row = await db
        .selectFrom("organization")
        .select(["deletedAt"])
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow()

      expect(row.deletedAt).not.toBeNull()
    })
  })
})
