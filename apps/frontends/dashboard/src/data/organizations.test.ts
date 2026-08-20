import { describe, expect, it } from "vitest"
import { organizationRoleLabel, type Organization } from "./organizations"

/**
 * The label under the team name in the switcher.
 *
 * It read "Member" for organization admins for as long as `GET /v1/orgs` carried only
 * `ownerUserId` — the endpoint could not say what the caller was, so the UI said the only thing it
 * could prove. Now that the list carries the caller's own roles, these are the cases that decide
 * what one line of sidebar chrome says about somebody's standing in a team.
 */
function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f",
    slug: "acme",
    name: "Acme",
    initial: "A",
    kind: "team",
    isOwner: false,
    roleNames: [],
    ...overrides,
  }
}

describe("organizationRoleLabel", () => {
  it("says Admin for an admin, which is the case that was wrong", () => {
    expect(organizationRoleLabel(organization({ roleNames: ["admin"] }))).toBe("Admin")
  })

  it("says Member for a member", () => {
    expect(organizationRoleLabel(organization({ roleNames: ["member"] }))).toBe("Member")
  })

  it("prefers ownership of record over the role list", () => {
    /*
      Ownership is a column on the organization, not a role — someone can hold a role named `owner`
      without being the owner of record, and the switcher should say what the database says.
    */
    expect(organizationRoleLabel(organization({ isOwner: true, roleNames: ["admin"] }))).toBe(
      "Owner",
    )
    expect(organizationRoleLabel(organization({ isOwner: false, roleNames: ["owner"] }))).toBe(
      "Member",
    )
  })

  it("shows a custom role under the name the customer gave it", () => {
    // Roles are org-defined RBAC rows, not an enum. A label that only knew the three seeded ones
    // would render a customer's own role as "Member", which is the same bug in a smaller place.
    expect(organizationRoleLabel(organization({ roleNames: ["billing-only"] }))).toBe(
      "billing-only",
    )
  })

  it("falls back to Member when the caller holds no role at all", () => {
    // A real state: a membership row can exist with no role attached.
    expect(organizationRoleLabel(organization({ roleNames: [] }))).toBe("Member")
  })

  it("shows one role rather than all of them", () => {
    // A member may hold several. One line of sidebar chrome is not where they are enumerated.
    expect(organizationRoleLabel(organization({ roleNames: ["admin", "billing-only"] }))).toBe(
      "Admin",
    )
  })

  it("says nothing when there is no organization yet", () => {
    expect(organizationRoleLabel(undefined)).toBe("")
  })
})
