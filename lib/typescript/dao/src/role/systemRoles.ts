/**
 * The three system roles every organization gets.
 *
 * This is the runtime twin of `apps/dbmigrator/src/lib/system-roles.ts`. The migrator seeds
 * existing organizations from its copy and this file provisions new ones, so the two must stay
 * identical or an organization's authority would depend on which code path created it.
 * `apps/internal-api/src/rbac/actions.test.ts` imports both and asserts they match.
 *
 * Statements are IAM-shaped and expressed in the ADR 0016 grammar: colon separators only, and
 * resources are always SRNs scoped to the owning organization.
 */

export type SystemRoleStatement = {
  effect: "allow" | "deny"
  actions: string[]
}

export type SystemRoleDefinition = {
  name: string
  description: string
  statements: SystemRoleStatement[]
}

export const OWNER_ROLE_NAME = "owner"
export const ADMIN_ROLE_NAME = "admin"
export const MEMBER_ROLE_NAME = "member"

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    name: OWNER_ROLE_NAME,
    description: "Full control of the organization, including deletion and ownership transfer.",
    statements: [{ effect: "allow", actions: ["*"] }],
  },
  {
    name: ADMIN_ROLE_NAME,
    description: "Full control except deleting the organization, transferring it, or spending.",
    statements: [
      { effect: "allow", actions: ["*"] },
      {
        effect: "deny",
        actions: ["org:delete", "org:transfer_ownership", "billing:write", "billing:refund"],
      },
    ],
  },
  {
    name: MEMBER_ROLE_NAME,
    description: "Read everything in the organization, create projects, and run workflows.",
    statements: [
      {
        effect: "allow",
        actions: [
          "org:read",
          "member:read",
          "role:read",
          "billing:read",
          "usage:read",
          "github:read",
          "credential:read",
          "project:read",
          "project:create",
          "repository:read",
          "deployment:read",
          "sandbox:read",
          "sandbox:write",
          "workflow:read",
          "workflow:run",
          "workflow:job:read",
          "database:read",
          "search:read",
          "cache:read",
          "observability:logs:read",
          "store:fork",
        ],
      },
    ],
  },
]

export const SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set(SYSTEM_ROLES.map((role) => role.name))
