/**
 * The three system roles every organization gets, expressed in the ADR 0016 grammar:
 * colon separators only, resources are always SRNs scoped to the owning organization.
 *
 * `role.is_system = true` marks them so custom roles reuse exactly one code path. Seeding them
 * from here means the vocabulary has one home; the API's action catalogue must agree with it.
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

export const orgScopedResource = (organizationId: string): string =>
  `srn:sproutos:*:${organizationId}:*`

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    name: "owner",
    description: "Full control of the organization, including deletion and ownership transfer.",
    statements: [{ effect: "allow", actions: ["*"] }],
  },
  {
    name: "admin",
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
    name: "member",
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
