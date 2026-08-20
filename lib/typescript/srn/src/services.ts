import { SRN_PREFIX, WILDCARD } from "./srn"

/**
 * The services an SRN may name.
 *
 * The grammar itself is syntactic and accepts any lowercase token here; this list is the
 * vocabulary the platform actually uses, so a typo in a route becomes a type error rather than a
 * permission that silently never matches.
 */
export const SRN_SERVICES = [
  "org",
  "project",
  "repository",
  "db",
  "workflow",
  "store",
  "billing",
  "oauth",
  "search",
  "cache",
  "agent",
  "compute",
  "observability",
  "github",
  "infra",
] as const

export type SrnService = (typeof SRN_SERVICES)[number]

/**
 * Builds the SRN for one resource owned by one organization.
 *
 * The organization segment must come from the resolved organization, never from request input —
 * see ADR 0016. Ids are lowercased because the grammar rejects uppercase outright, and a UUID
 * that arrives uppercased from a client would otherwise fail to parse at the authorization
 * boundary rather than at the edge.
 */
export function srnFor(
  service: SrnService,
  organizationId: string,
  resourceType: string,
  id: string,
): string {
  return `${SRN_PREFIX}${service}:${organizationId.toLowerCase()}:${resourceType}/${id.toLowerCase()}`
}

/** The pattern covering everything one organization owns, as seeded into the system roles. */
export function organizationScopeSrn(organizationId: string): string {
  return `${SRN_PREFIX}${WILDCARD}:${organizationId.toLowerCase()}:${WILDCARD}`
}
