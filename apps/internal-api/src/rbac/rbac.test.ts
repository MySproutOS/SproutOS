// Fixtures are built in order and each assertion reads the row the previous one wrote.
/* oxlint-disable no-await-in-loop, unicorn/consistent-function-scoping */
import {
  crudMemberPermission,
  crudOrganizationMember,
  crudRole,
  fetchMemberPermission,
  fetchOrganizationMember,
  fetchRole,
  provisionOrganization,
  SYSTEM_ROLES,
} from "@lib/dao"
import { expandSrnTarget, organizationScopeSrn, parseSrn, srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
// The migrator's copy of the same definitions. Imported across packages on purpose: the two must
// agree, and the only way to know they do is to compare them.
import { SYSTEM_ROLES as MIGRATOR_SYSTEM_ROLES } from "../../../dbmigrator/src/lib/system-roles"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"
import { ACTIONS, actionsCover, expandAction, isAction, isGrantableAction } from "./actions"

describe("the action catalogue", () => {
  it("uses `:` as the only separator", () => {
    for (const action of ACTIONS) {
      expect(action).not.toContain(".")
      expect(action).toMatch(/^[a-z_]+(?::[a-z_]+)+$/)
    }
  })

  it("has no duplicates", () => {
    expect(new Set<string>(ACTIONS).size).toBe(ACTIONS.length)
  })

  it("covers every action the system roles grant or deny", () => {
    for (const role of SYSTEM_ROLES) {
      for (const statement of role.statements) {
        for (const action of statement.actions) {
          expect([role.name, action, isGrantableAction(action)]).toStrictEqual([
            role.name,
            action,
            true,
          ])
        }
      }
    }
  })

  it("matches the migrator's system role definitions byte for byte", () => {
    expect(SYSTEM_ROLES).toStrictEqual(MIGRATOR_SYSTEM_ROLES)
  })

  it("rejects strings outside the catalogue", () => {
    expect(isAction("project:writ")).toBe(false)
    expect(isGrantableAction("project:writ")).toBe(false)
    expect(isGrantableAction("nonsense:*")).toBe(false)
    expect(isGrantableAction("workflow.job.read")).toBe(false)
  })

  it("accepts wildcard forms only where the catalogue has something under them", () => {
    expect(isGrantableAction("*")).toBe(true)
    expect(isGrantableAction("workflow:*")).toBe(true)
    expect(isGrantableAction("workflow:job:*")).toBe(true)
    expect(isGrantableAction("workflow:jobs:*")).toBe(false)
  })
})

describe("action expansion", () => {
  it("expands on `:` boundaries and includes the exact action", () => {
    expect(expandAction("workflow:job:read")).toStrictEqual([
      "*",
      "workflow:*",
      "workflow:job:*",
      "workflow:job:read",
    ])
  })

  it("expands a two-segment action", () => {
    expect(expandAction("org:delete")).toStrictEqual(["*", "org:*", "org:delete"])
  })

  it("never expands on a dot, so a dotted action would match nothing broader", () => {
    expect(expandAction("workflow:job.read")).toStrictEqual([
      "*",
      "workflow:*",
      "workflow:job.read",
    ])
  })

  it("matches a grant through any of its wildcard ancestors", () => {
    expect(actionsCover(["*"], "org:delete")).toBe(true)
    expect(actionsCover(["workflow:*"], "workflow:job:read")).toBe(true)
    expect(actionsCover(["workflow:job:*"], "workflow:job:read")).toBe(true)
    expect(actionsCover(["workflow:read"], "workflow:job:read")).toBe(false)
    expect(actionsCover(["org:read"], "org:delete")).toBe(false)
  })
})

const reachable = await databaseReachable()

describe.skipIf(!reachable)("permission evaluation", () => {
  let owner: TestUser
  let admin: TestUser
  let plain: TestUser
  let outsider: TestUser
  let organizationId: string
  let otherOrganizationId: string

  /** The target every org-level check in this suite is asked about. */
  function orgTarget(id: string) {
    return expandSrnTarget(parseSrn(srnFor("org", id, "organization", id)))
  }

  async function evaluate(userId: string, orgId: string, action: string, target: string[]) {
    return await fetchMemberPermission(db).evaluate(userId, orgId, expandAction(action), target)
  }

  async function membershipOf(orgId: string, userId: string): Promise<string> {
    const membership = await fetchOrganizationMember(db).getForUser(orgId, userId)
    if (!membership) throw new Error("membership missing")
    return membership.id
  }

  async function grantRole(orgId: string, userId: string, roleName: string): Promise<void> {
    const role = await fetchRole(db).getByName(orgId, roleName, ["id"])
    if (!role) throw new Error(`role ${roleName} missing`)

    await db.transaction().execute(async (tx) => {
      await crudOrganizationMember(tx).assignRole(await membershipOf(orgId, userId), role.id)
      await crudMemberPermission(tx).rebuildOrganization(orgId)
    })
  }

  async function joinOrganization(orgId: string, userId: string): Promise<void> {
    await db.transaction().execute(async (tx) => {
      await crudOrganizationMember(tx).create({
        organizationId: orgId,
        userId,
        status: "active",
      })
    })
  }

  beforeAll(async () => {
    owner = await createTestUser("owner")
    admin = await createTestUser("admin")
    plain = await createTestUser("plain")
    outsider = await createTestUser("outsider")

    const organization = await provisionOrganization(db).createOrganization({
      userId: owner.id,
      name: "RBAC Suite",
    })
    organizationId = trackOrganization(organization.id)

    const other = await provisionOrganization(db).createOrganization({
      userId: outsider.id,
      name: "Other Tenant",
    })
    otherOrganizationId = trackOrganization(other.id)

    await joinOrganization(organizationId, admin.id)
    await grantRole(organizationId, admin.id, "admin")
    await joinOrganization(organizationId, plain.id)
    await grantRole(organizationId, plain.id, "member")
  })

  afterAll(async () => {
    await cleanupFixtures()
  })

  it("gives the owner everything through the `*` grant", async () => {
    const target = orgTarget(organizationId)
    for (const action of ["org:read", "org:update", "org:delete", "org:transfer_ownership"]) {
      const decision = await evaluate(owner.id, organizationId, action, target)
      expect([action, decision]).toStrictEqual([action, { allowed: true, denied: false }])
    }
  })

  it("lets an admin do everything the deny statement does not name", async () => {
    const target = orgTarget(organizationId)
    const decision = await evaluate(admin.id, organizationId, "org:update", target)
    expect(decision).toStrictEqual({ allowed: true, denied: false })
  })

  /**
   * The core rule. The admin role holds `allow *` and `deny org:delete` as two rows, so both match
   * and only the `bool_or(effect = 'deny')` half of the query distinguishes them. A check that
   * looked for "is there an allow" would hand an admin the delete button.
   */
  it("denies an admin the actions the deny statement names, even though `*` allows them", async () => {
    const target = orgTarget(organizationId)

    for (const action of ["org:delete", "org:transfer_ownership", "billing:write"]) {
      const decision = await evaluate(admin.id, organizationId, action, target)
      expect([action, decision.allowed, decision.denied]).toStrictEqual([action, true, true])
    }
  })

  it("gives a plain member reads but no allow at all for destructive actions", async () => {
    const target = orgTarget(organizationId)

    expect(await evaluate(plain.id, organizationId, "org:read", target)).toStrictEqual({
      allowed: true,
      denied: false,
    })
    expect(await evaluate(plain.id, organizationId, "org:delete", target)).toStrictEqual({
      allowed: false,
      denied: false,
    })
  })

  it("keeps deny winning when the allow and the deny come from two different roles", async () => {
    const denier = await createTestUser("denier")
    await joinOrganization(organizationId, denier.id)
    await grantRole(organizationId, denier.id, "member")

    const role = await db.transaction().execute(async (tx) => {
      const created = await crudRole(tx).create({
        organizationId,
        name: `deny-reads-${Date.now()}`,
        isSystem: false,
      })
      await crudRole(tx).replaceStatements(created.id, [
        {
          effect: "deny",
          actions: ["org:read"],
          resources: [organizationScopeSrn(organizationId)],
        },
      ])
      await crudOrganizationMember(tx).assignRole(
        await membershipOf(organizationId, denier.id),
        created.id,
      )
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
      return created
    })

    const decision = await evaluate(
      denier.id,
      organizationId,
      "org:read",
      orgTarget(organizationId),
    )
    expect(decision).toStrictEqual({ allowed: true, denied: true })

    await db.transaction().execute(async (tx) => {
      await crudRole(tx).remove(organizationId, role.id)
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
    })
  })

  /**
   * The trap ADR 0016 calls out. `@>` is evaluated per row, so a member who holds two actions
   * through two different roles has them on two rows and containment fails on both — the query
   * reports "no" for a member who genuinely holds everything asked for.
   */
  it("does not answer `holds all of these` with a single `@>`", async () => {
    const split = await createTestUser("split")
    await joinOrganization(organizationId, split.id)

    const [first, second] = await db.transaction().execute(async (tx) => {
      const membershipId = await membershipOf(organizationId, split.id)
      const resources = [organizationScopeSrn(organizationId)]

      const roleA = await crudRole(tx).create({
        organizationId,
        name: `split-a-${Date.now()}`,
        isSystem: false,
      })
      await crudRole(tx).replaceStatements(roleA.id, [
        { effect: "allow", actions: ["project:create"], resources },
      ])

      const roleB = await crudRole(tx).create({
        organizationId,
        name: `split-b-${Date.now()}`,
        isSystem: false,
      })
      await crudRole(tx).replaceStatements(roleB.id, [
        { effect: "allow", actions: ["project:delete"], resources },
      ])

      await crudOrganizationMember(tx).assignRole(membershipId, roleA.id)
      await crudOrganizationMember(tx).assignRole(membershipId, roleB.id)
      await crudMemberPermission(tx).rebuildOrganization(organizationId)

      return [roleA, roleB]
    })

    const target = orgTarget(organizationId)

    // Both actions really are held.
    expect((await evaluate(split.id, organizationId, "project:create", target)).allowed).toBe(true)
    expect((await evaluate(split.id, organizationId, "project:delete", target)).allowed).toBe(true)

    // …and the naive containment query says otherwise, which is the whole point.
    const naive = await sql<{ count: string }>`
      select count(*) as count
      from member_permission
      where user_id = ${split.id}
        and organization_id = ${organizationId}
        and actions @> array['project:create', 'project:delete']::text[]
    `.execute(db)
    expect(Number(naive.rows[0].count)).toBe(0)

    // Aggregating across rows is what gives union semantics.
    const grants = await fetchMemberPermission(db).matchingGrants(
      split.id,
      organizationId,
      [...expandAction("project:create"), ...expandAction("project:delete")],
      target,
    )
    const held = grants.filter((grant) => grant.effect === "allow")
    expect(held.some((grant) => actionsCover(grant.actions, "project:create"))).toBe(true)
    expect(held.some((grant) => actionsCover(grant.actions, "project:delete"))).toBe(true)

    await db.transaction().execute(async (tx) => {
      await crudRole(tx).remove(organizationId, first.id)
      await crudRole(tx).remove(organizationId, second.id)
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
    })
  })

  it("does not let a member of one organization reach another", async () => {
    const ownTarget = orgTarget(organizationId)
    const foreignTarget = orgTarget(otherOrganizationId)

    expect(await evaluate(owner.id, organizationId, "org:delete", ownTarget)).toStrictEqual({
      allowed: true,
      denied: false,
    })

    // The owner of one team, asked about another team's organization row.
    expect(await evaluate(owner.id, otherOrganizationId, "org:read", foreignTarget)).toStrictEqual({
      allowed: false,
      denied: false,
    })

    // And their own broad grant does not reach across, even evaluated in their own organization:
    // the resource segment carries the other organization's id, so nothing overlaps.
    expect(await evaluate(owner.id, organizationId, "org:read", foreignTarget)).toStrictEqual({
      allowed: false,
      denied: false,
    })
  })

  it("scopes a grant to the resource it names", async () => {
    const scoped = await createTestUser("scoped")
    await joinOrganization(organizationId, scoped.id)

    const projectId = "01912d41-0000-7000-8000-0000000000b1"
    const otherProjectId = "01912d41-0000-7000-8000-0000000000b2"

    const role = await db.transaction().execute(async (tx) => {
      const created = await crudRole(tx).create({
        organizationId,
        name: `scoped-${Date.now()}`,
        isSystem: false,
      })
      await crudRole(tx).replaceStatements(created.id, [
        {
          effect: "allow",
          actions: ["project:update"],
          resources: [srnFor("project", organizationId, "project", projectId)],
        },
      ])
      await crudOrganizationMember(tx).assignRole(
        await membershipOf(organizationId, scoped.id),
        created.id,
      )
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
      return created
    })

    const allowed = expandSrnTarget(
      parseSrn(srnFor("project", organizationId, "project", projectId)),
    )
    const forbidden = expandSrnTarget(
      parseSrn(srnFor("project", organizationId, "project", otherProjectId)),
    )

    expect((await evaluate(scoped.id, organizationId, "project:update", allowed)).allowed).toBe(
      true,
    )
    expect((await evaluate(scoped.id, organizationId, "project:update", forbidden)).allowed).toBe(
      false,
    )

    await db.transaction().execute(async (tx) => {
      await crudRole(tx).remove(organizationId, role.id)
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
    })
  })

  /**
   * `member_permission.member_role_id ON DELETE CASCADE` cleans up after a revoked assignment, and
   * does nothing at all for a statement edit. This test asserts the stale state explicitly, so the
   * rebuild in the roles route can never be quietly dropped as redundant.
   */
  it("keeps authorizing under the old statements until the denormalization is rebuilt", async () => {
    const editable = await createTestUser("editable")
    await joinOrganization(organizationId, editable.id)

    const role = await db.transaction().execute(async (tx) => {
      const created = await crudRole(tx).create({
        organizationId,
        name: `editable-${Date.now()}`,
        isSystem: false,
      })
      await crudRole(tx).replaceStatements(created.id, [
        {
          effect: "allow",
          actions: ["project:create"],
          resources: [organizationScopeSrn(organizationId)],
        },
      ])
      await crudOrganizationMember(tx).assignRole(
        await membershipOf(organizationId, editable.id),
        created.id,
      )
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
      return created
    })

    const target = orgTarget(organizationId)
    expect((await evaluate(editable.id, organizationId, "project:create", target)).allowed).toBe(
      true,
    )

    // Edit the statement and deliberately skip the rebuild.
    await crudRole(db).replaceStatements(role.id, [
      {
        effect: "allow",
        actions: ["project:read"],
        resources: [organizationScopeSrn(organizationId)],
      },
    ])

    // Still true: the stale denormalization is what authorizes, and nothing rebuilt it.
    expect((await evaluate(editable.id, organizationId, "project:create", target)).allowed).toBe(
      true,
    )

    await crudMemberPermission(db).rebuildOrganization(organizationId)

    expect((await evaluate(editable.id, organizationId, "project:create", target)).allowed).toBe(
      false,
    )
    expect((await evaluate(editable.id, organizationId, "project:read", target)).allowed).toBe(true)

    await db.transaction().execute(async (tx) => {
      await crudRole(tx).remove(organizationId, role.id)
      await crudMemberPermission(tx).rebuildOrganization(organizationId)
    })
  })

  it("revokes authority when the assignment is deleted, without a rebuild", async () => {
    const membershipId = await membershipOf(organizationId, plain.id)
    const target = orgTarget(organizationId)

    expect((await evaluate(plain.id, organizationId, "org:read", target)).allowed).toBe(true)

    await crudOrganizationMember(db).clearRoles(membershipId)
    expect((await evaluate(plain.id, organizationId, "org:read", target)).allowed).toBe(false)

    await grantRole(organizationId, plain.id, "member")
    expect((await evaluate(plain.id, organizationId, "org:read", target)).allowed).toBe(true)
  })
})
