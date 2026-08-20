// Slug disambiguation is order-dependent, so these creations cannot be parallelised.
/* oxlint-disable no-await-in-loop */
import {
  fetchOrganizationMember,
  fetchRole,
  fetchUserPreference,
  isValidOrganizationSlug,
  provisionOrganization,
  RESERVED_ORGANIZATION_SLUGS,
  slugifyOrganizationName,
} from "@lib/dao"
import { db } from "@sproutos/db"
import { afterAll, describe, expect, it } from "vitest"
import {
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  trackOrganization,
} from "../test/fixtures"

describe("slug rules", () => {
  it("folds diacritics rather than dropping the letters", () => {
    expect(slugifyOrganizationName("Café Team")).toBe("cafe-team")
  })

  it("collapses punctuation and trims hyphens", () => {
    expect(slugifyOrganizationName("  Ada's  Team!! ")).toBe("ada-s-team")
  })

  it("falls back to `team` for a name that reduces to nothing", () => {
    expect(slugifyOrganizationName("🌱🌱")).toBe("team")
  })

  it("refuses reserved words", () => {
    for (const reserved of RESERVED_ORGANIZATION_SLUGS) {
      expect([reserved, isValidOrganizationSlug(reserved)]).toStrictEqual([reserved, false])
    }
  })

  it("refuses malformed slugs", () => {
    expect(isValidOrganizationSlug("A")).toBe(false)
    expect(isValidOrganizationSlug("-leading")).toBe(false)
    expect(isValidOrganizationSlug("trailing-")).toBe(false)
    expect(isValidOrganizationSlug("Upper")).toBe(false)
    expect(isValidOrganizationSlug("double--hyphen")).toBe(false)
    expect(isValidOrganizationSlug("has space")).toBe(false)
  })

  it("accepts ordinary slugs", () => {
    expect(isValidOrganizationSlug("ada-s-team")).toBe(true)
    expect(isValidOrganizationSlug("team42")).toBe(true)
  })
})

const reachable = await databaseReachable()

describe.skipIf(!reachable)("sign-in provisioning", () => {
  afterAll(async () => {
    await cleanupFixtures()
  })

  it("places a new user in a personal organization named after them", async () => {
    const user = await createTestUser("firstsignin")

    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Ada Lovelace",
      email: user.email,
    })
    trackOrganization(organization.id)

    expect(organization.created).toBe(true)
    expect(organization.name).toBe("Ada Lovelace's Team")
    expect(organization.kind).toBe("personal")
    expect(organization.slug.startsWith("ada-lovelace-s-team")).toBe(true)
  })

  it("gives that organization the three system roles and the owner role to its owner", async () => {
    const user = await createTestUser("rolesetup")
    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Grace Hopper",
      email: user.email,
    })
    trackOrganization(organization.id)

    const roles = await fetchRole(db).listQuery(organization.id).execute()
    expect(roles.map((role) => role.name).sort()).toStrictEqual(["admin", "member", "owner"])
    expect(roles.every((role) => role.isSystem)).toBe(true)

    const membership = await fetchOrganizationMember(db).getForUser(organization.id, user.id)
    const held = await fetchOrganizationMember(db).listRolesForMembers([membership?.id ?? ""])
    expect(held.map((row) => row.name)).toStrictEqual(["owner"])

    const permissions = await db
      .selectFrom("memberPermission")
      .selectAll()
      .where("organizationId", "=", organization.id)
      .execute()
    expect(permissions).toHaveLength(1)
    expect(permissions[0].actions).toStrictEqual(["*"])
    expect(permissions[0].resources).toStrictEqual([`srn:sproutos:*:${organization.id}:*`])
  })

  it("points the user's last-org preference at it", async () => {
    const user = await createTestUser("preference")
    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Katherine Johnson",
      email: user.email,
    })
    trackOrganization(organization.id)

    expect(await fetchUserPreference(db).getLastOrganizationId(user.id)).toBe(organization.id)
  })

  /** The OAuth callback calls this on every sign-in, not only the first. */
  it("is idempotent and writes nothing on a repeat sign-in", async () => {
    const user = await createTestUser("repeat")

    const first = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Repeat User",
      email: user.email,
    })
    trackOrganization(first.id)

    const second = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: "Repeat User",
      email: user.email,
    })

    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)

    const organizations = await db
      .selectFrom("organization")
      .select("id")
      .where("ownerUserId", "=", user.id)
      .execute()
    expect(organizations).toHaveLength(1)
  })

  it("falls back to the email local part when the profile has no name", async () => {
    const user = await createTestUser("noname")
    const organization = await provisionOrganization(db).ensureDefaultOrganization({
      userId: user.id,
      name: null,
      email: user.email,
    })
    trackOrganization(organization.id)

    expect(organization.name).toBe(`${user.email.split("@")[0]}'s Team`)
  })

  it("disambiguates a slug two people would both want", async () => {
    const first = await createTestUser("collidea")
    const second = await createTestUser("collideb")

    const a = await provisionOrganization(db).createOrganization({
      userId: first.id,
      name: "Identical Team",
    })
    const b = await provisionOrganization(db).createOrganization({
      userId: second.id,
      name: "Identical Team",
    })
    trackOrganization(a.id)
    trackOrganization(b.id)

    expect(a.slug).toBe("identical-team")
    expect(b.slug).toBe("identical-team-2")
  })

  it("creates additional organizations without limit, as `team` rather than `personal`", async () => {
    const user = await createTestUser("unlimited")

    const created = []
    for (let index = 0; index < 4; index += 1) {
      const organization = await provisionOrganization(db).createOrganization({
        userId: user.id,
        name: `Extra Team ${index}`,
      })
      trackOrganization(organization.id)
      created.push(organization)
    }

    expect(created.every((organization) => organization.kind === "team")).toBe(true)
    expect(new Set(created.map((organization) => organization.slug)).size).toBe(4)
  })
})
